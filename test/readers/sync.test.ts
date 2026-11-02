import {readerSyncPublication,readerReservationBookkeeping} from "../../src/reader-sync";
test("coverage bookkeeping cannot trigger a self-sustaining refresh loop",()=>{
  const event={ns:{coll:"reservations"},operationType:"update",updateDescription:{updatedFields:{reader_monitors:{},reader_state_version:4,updated_at:new Date()}}};
  expect(readerReservationBookkeeping(event)).toBe(true);
  expect(readerReservationBookkeeping({...event,updateDescription:{updatedFields:{arrived_at:new Date(),reader_state_version:5}}})).toBe(false);
  expect(readerReservationBookkeeping({...event,operationType:"delete"})).toBe(false);
});
test.each(["reservations","tool_groups"])("%s lifecycle hints never invalidate authorization",coll=>{
  for(const operationType of ["insert","update","replace","delete"]) {
    expect(readerSyncPublication({ns:{coll},operationType,documentKey:{_id:"moved"}}).topic).toBe("readers/all/reservations/refresh");
  }
});
test("reader capability advertisement does not stop active tools",()=>{
  expect(readerSyncPublication({ns:{coll:"nfc_readers"},operationType:"update",updateDescription:{updatedFields:{reservationEnabled:true}}}).topic).toBe("readers/all/reservations/refresh");
  expect(readerSyncPublication({ns:{coll:"nfc_readers"},operationType:"update",updateDescription:{updatedFields:{reservationEnabled:true,toolId:"new"}}}).topic).toBe("readers/all/invalidate");
});
test("reconnection requests refresh without stopping a running tool",()=>{
  expect(readerSyncPublication().topic).toBe("readers/all/refresh");
});
test.each(["tools","shops"])("%s outage changes stay scoped",coll=>{
  for(const out_of_service of [true,false]) {
    const document={_id:"tool",out_of_service};
    const event=readerSyncPublication({ns:{coll},operationType:"update",fullDocument:document});
    expect(event.topic).toBe(coll+"/update");expect(JSON.parse(event.payload).document).toEqual(document);
  }
  expect(JSON.parse(readerSyncPublication({ns:{coll},operationType:"delete",fullDocument:null,documentKey:{_id:"gone"}}).payload).document).toEqual({_id:"gone"});
});
test.each(["cards","members","tool_checkouts","nfc_card_credentials","nfc_readers"])("%s authorization change still invalidates",coll=>{
  expect(readerSyncPublication({ns:{coll},operationType:"update"}).topic).toBe("readers/all/invalidate");
});
