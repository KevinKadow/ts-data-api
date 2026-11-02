// Explicit operator command; does not run during API startup.
const { MongoClient } = require("mongodb");
(async () => {
  if (!process.env.READER_DATABASE || !process.env.READER_DATA_SOURCE)
    throw Error("Reader database configuration required");
  const sources = JSON.parse(process.env.DATA_SOURCES || "{}");
  const client = new MongoClient(sources[process.env.READER_DATA_SOURCE]);
  try {
    const db = client.db(process.env.READER_DATABASE);
    await db
      .collection("nfc_readers")
      .createIndex({ name: 1 }, { unique: true });
    await db
      .collection("nfc_readers")
      .createIndex({ certificateFingerprint: 1 }, { unique: true });
    // Fail rather than deleting/merging existing duplicate session endings.
    await db.collection("checkend").createIndex(
      {deviceId:1, checkinId:1},
      {unique:true, name:"one_end_per_reader_checkin", partialFilterExpression:{checkinId:{$type:"string"}}}
    );
    await db.collection("nfc_readers").createIndex({enabled:1,role:1,reservationEnabled:1,toolId:1});
    await db.collection("checkins").createIndex({deviceId:1,validity:1,timeOf:-1});
    await db.collection("checkins").createIndex({deviceId:1,memberId:1,validity:1,timeOf:1});
    // Existing Rails index shapes; creation is idempotent and never drops data.
    await db.collection("reservations").createIndex({shop_id:1,status:1,start_at:1,end_at:1});
    await db.collection("reservations").createIndex({tool_ids:1,status:1,start_at:1,end_at:1});
  } finally {
    await client.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
