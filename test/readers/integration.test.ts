import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";
import { toPlainHandler } from "h3";
import { reservationFilter } from '../../src/reader-reservations';
let repl: MongoMemoryReplSet,
  client: MongoClient,
  handler: any,
  readerId: ObjectId,
  cardId: ObjectId,
  memberId: ObjectId;
const fingerprint = "ab".repeat(32);
describe('tool reservation reads and lifecycle forwarding', () => {
  async function toolReader() {
    const db=client.db('reader_test'), toolId=new ObjectId(), shopId=new ObjectId();
    await db.collection('shops').insertOne({_id:shopId,name:'Wood',reservable:false});
    await db.collection('tools').insertOne({_id:toolId,shop_id:shopId,name:'Saw',reservable:false});
    await db.collection('nfc_readers').updateOne({_id:readerId},{$set:{role:'tool',toolId}});
    return {db,toolId,shopId};
  }
  test('requires a tool reader and never grants arbitrary-query access',async()=>{
    expect((await call('/reader/v1/reservations')).status).toBe(403);
  });
  test('reads overlapping and four-hour bookings, including shop and group scope',async()=>{
    const {db,toolId,shopId}=await toolReader();
    const now=Date.now();
    const common={member_id:memberId,shop_id:shopId,status:'approved',reservation_scope:'tools',tool_ids:[String(toolId)],end_at:new Date(now+18000000)};
    await db.collection('reservations').insertMany([
      {...common,start_at:new Date(now-1000)},
      {...common,start_at:new Date(now+14400000)},
      {...common,start_at:new Date(now+14400001)},
      {...common,start_at:new Date(now),status:'abandoned'},
      {...common,start_at:new Date(now),status:'pending'},
      {...common,start_at:new Date(now),tool_ids:[String(new ObjectId())]},
      {...common,start_at:new Date(now),reservation_scope:'shop',tool_ids:[]}
    ]);
    const result=await call(`/reader/v1/reservations?at=${now}`);
    expect(result.status).toBe(200);
    expect(result.body.reservable).toBe(true);
    expect(result.body.reservations).toHaveLength(3);
    expect(result.body.hintTopics).toEqual(['reservations/Wood','reservations/Wood/UpNext','reservations/Wood/Saw','reservations/Wood/Saw/UpNext']);
    expect(result.body.reservations.every((r:any)=>r.memberId===String(memberId) && Number.isInteger(r.endAt))).toBe(true);
  });
  test('paginates deterministically and does not expose a supplied foreign tool',async()=>{
    const {db,toolId,shopId}=await toolReader(); const now=Date.now();
    await db.collection('reservations').insertMany(Array.from({length:35},()=>({member_id:memberId,shop_id:shopId,
      status:'approved',reservation_scope:'tools',tool_ids:[String(toolId)],start_at:new Date(now+3600000),end_at:new Date(now+7200000)})));
    const first=await call(`/reader/v1/reservations?at=${now}&toolId=${new ObjectId()}`);
    expect(first.body.reservations).toHaveLength(32); expect(first.body.complete).toBe(false);
    const second=await call(`/reader/v1/reservations?at=${now}&after=${first.body.next}`);
    expect(second.body.reservations).toHaveLength(3); expect(second.body.complete).toBe(true);
    expect(new Set([...first.body.reservations,...second.body.reservations].map(r=>r.id)).size).toBe(35);
  });
  test('uses bounded indexed tool/shop scans against representative unrelated history',async()=>{
    const {db,toolId,shopId}=await toolReader(), now=Date.now();
    const reservations=db.collection('reservations');
    await reservations.createIndex({tool_ids:1,status:1,start_at:1,end_at:1});
    await reservations.createIndex({shop_id:1,status:1,start_at:1,end_at:1});
    await reservations.insertMany(Array.from({length:2000},(_,i)=>({member_id:memberId,shop_id:new ObjectId(),tool_ids:[String(new ObjectId())],
      status:i%2?'approved':'abandoned',reservation_scope:'tools',start_at:new Date(now-86400000),end_at:new Date(now-3600000)})));
    await reservations.insertMany([
      {shop_id:shopId,tool_ids:[String(toolId)],reservation_scope:'tools',status:'approved',start_at:new Date(now),end_at:new Date(now+3600000)},
      {shop_id:shopId,tool_ids:[],reservation_scope:'shop',status:'approved',start_at:new Date(now),end_at:new Date(now+3600000)}]);
    const plan=await reservations.find(reservationFilter({_id:toolId,shop_id:shopId},now)).sort({start_at:1,_id:1}).limit(33).explain('executionStats');
    expect(plan.executionStats.nReturned).toBe(2);
    expect(plan.executionStats.totalDocsExamined).toBeLessThan(20);
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('IXSCAN');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  });
  test('recognizes a reservable group and returns explicit negative capability',async()=>{
    const {db,toolId,shopId}=await toolReader();
    expect((await call('/reader/v1/reservations')).body.reservable).toBe(false);
    await db.collection('tool_groups').insertOne({shop_id:shopId,included_tool_ids:[String(toolId)],reservable:true});
    expect((await call('/reader/v1/reservations')).body.reservable).toBe(true);
  });
  test('forwards only verified device identity and keeps the service secret server-side',async()=>{
    await toolReader();
    const oldUrl=process.env.READER_RAILS_URL,oldSecret=process.env.READER_RESERVATION_SERVICE_SECRET;
    process.env.READER_RAILS_URL='https://rails.example.test';process.env.READER_RESERVATION_SERVICE_SECRET='x'.repeat(40);
    const mocked=jest.spyOn(global,'fetch').mockResolvedValue(new Response(JSON.stringify({results:[],serverTime:Date.now()}),{status:200}));
    try {
      const result=await call('/reader/v1/reservations/sync',{capable:true,deviceId:String(new ObjectId()),operations:[]});
      expect(result.status).toBe(200);
      const forwarded=JSON.parse(String(mocked.mock.calls[0][1]?.body));
      expect(forwarded.deviceId).toBe(String(readerId));
      expect(JSON.stringify(result.body)).not.toContain(process.env.READER_RESERVATION_SERVICE_SECRET);
    } finally {
      mocked.mockRestore();
      if(oldUrl===undefined) delete process.env.READER_RAILS_URL; else process.env.READER_RAILS_URL=oldUrl;
      if(oldSecret===undefined) delete process.env.READER_RESERVATION_SERVICE_SECRET; else process.env.READER_RESERVATION_SERVICE_SECRET=oldSecret;
    }
  });
});
async function call(path: string, body?: any, headers: any = {}) {
  const r = await handler({
    path,
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "x-reader-proxy-secret": "test-proxy",
      "x-reader-certificate": fingerprint,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: JSON.parse(r.body) };
}
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.DATA_SOURCES = JSON.stringify({ local: repl.getUri() });
  process.env.READER_DATA_SOURCE = "local";
  process.env.READER_DATABASE = "reader_test";
  process.env.READER_PROXY_SECRET = "test-proxy";
  process.env.READER_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString(
    "base64",
  );
  client = new MongoClient(repl.getUri());
  await client.connect();
  const { app } = require("../../src/app");
  handler = toPlainHandler(app);
}, 120000);
beforeEach(async () => {
  await client.db("reader_test").dropDatabase();
  await client.db("reader_test").collection("checkend").createIndex(
    {deviceId:1,checkinId:1},{unique:true,partialFilterExpression:{checkinId:{$type:"string"}}});
  readerId = new ObjectId();
  memberId = new ObjectId();
  cardId = new ObjectId();
  await client
    .db("reader_test")
    .collection("nfc_readers")
    .insertOne({
      _id: readerId,
      name: "test-reader",
      role: "door",
      enrollmentEnabled: true,
      enabled: true,
      certificateFingerprint: fingerprint,
    });
  await client
    .db("reader_test")
    .collection("members")
    .insertOne({
      _id: memberId,
      status: "activeMember",
      expirationTime: Date.now() + 86400000,
    });
  await client
    .db("reader_test")
    .collection("cards")
    .insertOne({
      _id: cardId,
      uid: "00112233",
      member_id: memberId,
      holder: "Test Member",
      validity: "activeMember",
      expiry: Date.now() + 86400000,
    });
});
afterAll(async () => {
  if (client) await client.close();
  const { dataSources } = require("../../src/mdb");
  await Promise.all(Object.values(dataSources).map((c: any) => c.close()));
  if (repl) await repl.stop();
});
test("rejects missing proxy identity and unrestricted legacy access", async () => {
  expect(
    (
      await call("/reader/v1/config", undefined, {
        "x-reader-proxy-secret": "",
      })
    ).status,
  ).toBe(401);
  expect((await call("/defaults/findOne", {})).status).toBe(401);
});
test("unknown is explicit and cannot enroll", async () => {
  expect(
    (await call("/reader/v1/cards/lookup", { uid: "11223344" })).body.document,
  ).toBeNull();
  expect(
    (await call("/reader/v1/enrollment/begin", { uid: "11223344" })).status,
  ).toBe(404);
});
test("enrollment retries recover keys; normal lookup never returns Key B", async () => {
  const first = await call("/reader/v1/enrollment/begin", { uid: "00112233" });
  expect(first.status).toBe(200);
  expect(first.body.keyA).toHaveLength(12);
  const again = await call("/reader/v1/enrollment/begin", { uid: "00112233" });
  expect(again.body.keyA).toBe(first.body.keyA);
  expect(
    (
      await call("/reader/v1/enrollment/commit", {
        uid: "00112233",
        enrollmentId: cardId.toString(),
        digest: "wrong",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call("/reader/v1/enrollment/commit", {
        uid: "00112233",
        enrollmentId: cardId.toString(),
        digest: first.body.digest,
      })
    ).status,
  ).toBe(200);
  const lookup = await call("/reader/v1/cards/lookup", { uid: "00112233" });
  expect(lookup.body.document.credential.keyB).toBeUndefined();
  const stored = await client
    .db("reader_test")
    .collection("nfc_card_credentials")
    .findOne({ _id: cardId });
  expect(JSON.stringify(stored)).not.toContain(first.body.keyA);
});
test("events are idempotent and conflicting replays fail", async () => {
  const event = {
    collection: "checkins",
    document: {
      _id: new ObjectId().toString(),
      uid: "00112233",
      validity: "activeMember",
      holder: "Test Member",
      reader: "test-reader",
      where: "doorboto32",
      time: Date.now(),
      reason: "activeMember",
    },
  };
  expect((await call("/reader/v1/events", event)).status).toBe(200);
  expect((await call("/reader/v1/events", event)).status).toBe(200);
  expect(
    await client.db("reader_test").collection("checkins").countDocuments(),
  ).toBe(1);
  event.document.holder = "Changed";
  expect((await call("/reader/v1/events", event)).status).toBe(409);
  const stored = await client
    .db("reader_test")
    .collection("checkins")
    .findOne({});
  expect(stored!.timeOf).toBeInstanceOf(Date);
});
test("snapshot excludes superseded/revoked checkouts and retains outage grants", async () => {
  const db = client.db("reader_test"),
    tool = new ObjectId(),
    shop = new ObjectId();
  await db.collection("shops").insertOne({ _id: shop });
  await db.collection("tools").insertOne({ _id: tool, shop_id: shop });
  await db
    .collection("nfc_readers")
    .updateOne({ _id: readerId }, { $set: { role: "tool", toolId: tool } });
  await db.collection("tool_checkouts").insertMany([
    {
      tool_id: tool,
      member_id: memberId,
      revoked_at: null,
      superseded_by_id: null,
    },
    { tool_id: tool, member_id: new ObjectId(), revoked_at: new Date() },
    {
      tool_id: tool,
      member_id: new ObjectId(),
      superseded_by_id: new ObjectId(),
    },
  ]);
  const snapshot = await call("/reader/v1/snapshot");
  expect(snapshot.body.grants).toHaveLength(1);
  await db
    .collection("tools")
    .updateOne({ _id: tool }, { $set: { out_of_service: true } });
  expect((await call("/reader/v1/snapshot")).body.grants).toHaveLength(1);
});
test("disabled or unknown certificates cannot read keys", async () => {
  expect(
    (
      await call("/reader/v1/config", undefined, {
        "x-reader-certificate": "cd".repeat(32),
      })
    ).status,
  ).toBe(403);
  await client
    .db("reader_test")
    .collection("nfc_readers")
    .updateOne({ _id: readerId }, { $set: { enabled: false } });
  expect(
    (await call("/reader/v1/cards/lookup", { uid: "00112233" })).status,
  ).toBe(403);
});
test("reassignment and enrollment disable invalidate pending commit", async () => {
  const first = await call("/reader/v1/enrollment/begin", { uid: "00112233" });
  const commit = {
    uid: "00112233",
    enrollmentId: cardId.toString(),
    digest: first.body.digest,
  };
  await client
    .db("reader_test")
    .collection("nfc_readers")
    .updateOne({ _id: readerId }, { $set: { enrollmentEnabled: false } });
  expect((await call("/reader/v1/enrollment/commit", commit)).status).toBe(403);
  await client
    .db("reader_test")
    .collection("nfc_readers")
    .updateOne({ _id: readerId }, { $set: { enrollmentEnabled: true } });
  const other = new ObjectId();
  await client
    .db("reader_test")
    .collection("members")
    .insertOne({ _id: other });
  await client
    .db("reader_test")
    .collection("cards")
    .updateOne({ _id: cardId }, { $set: { member_id: other } });
  expect((await call("/reader/v1/enrollment/commit", commit)).status).toBe(409);
  expect(
    (await call("/reader/v1/cards/lookup", { uid: "00112233" })).body.document
      .credential,
  ).toBeNull();
});
test("concurrent enrollment attempts return the same pending material", async () => {
  const responses = await Promise.all([
    call("/reader/v1/enrollment/begin", { uid: "00112233" }),
    call("/reader/v1/enrollment/begin", { uid: "00112233" }),
  ]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  expect(responses[0].body.keyA).toBe(responses[1].body.keyA);
  expect(
    await client
      .db("reader_test")
      .collection("nfc_card_credentials")
      .countDocuments(),
  ).toBe(1);
});
test("unique names and tool configuration are enforced", async () => {
  const db = client.db("reader_test");
  await db.collection("nfc_readers").createIndex({ name: 1 }, { unique: true });
  await db
    .collection("nfc_readers")
    .insertOne({
      name: "other",
      enabled: true,
      certificateFingerprint: "cd".repeat(32),
    });
  expect(
    (
      await call("/reader/v1/config", {
        name: "other",
        role: "door",
        enrollmentEnabled: false,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call("/reader/v1/config", {
        name: "valid",
        role: "tool",
        enrollmentEnabled: false,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call("/reader/v1/config", {
        name: "renamed",
        role: "latch",
        enrollmentEnabled: false,
      })
    ).body.name,
  ).toBe("renamed");
  const event = {
    collection: "rejections",
    document: {
      _id: new ObjectId().toString(),
      uid: "00112233",
      validity: "lost",
      holder: null,
      reader: "test-reader",
      where: "doorboto32",
      time: 0,
      reason: "lost",
    },
  };
  expect((await call("/reader/v1/events", event)).status).toBe(200);
  const stored = await db.collection("rejections").findOne({});
  expect(stored!.timeOf).toBeNull();
  event.document.reader = "other";
  event.document._id = new ObjectId().toString();
  expect((await call("/reader/v1/events", event)).status).toBe(403);
});
test("duplicate UID and cache overflow fail instead of silently truncating access", async () => {
  const db = client.db("reader_test");
  await db.collection("cards").insertOne({ uid: "00112233" });
  expect(
    (await call("/reader/v1/cards/lookup", { uid: "00112233" })).status,
  ).toBe(409);
  expect((await call("/reader/v1/snapshot")).status).toBe(409);
  await db.collection("cards").deleteMany({});
  await db
    .collection("cards")
    .insertMany(
      Array.from({ length: 301 }, (_, i) => ({
        uid: i.toString(16).toUpperCase().padStart(8, "0"),
        member_id: memberId, validity: "activeMember", expiry: Date.now()+86400000,
      })),
    );
  expect((await call("/reader/v1/snapshot")).status).toBe(409);
});

test("tool outage retains grants and exposes scoped kick permission", async () => {
  const db=client.db("reader_test"), shopId=new ObjectId(), toolId=new ObjectId();
  await db.collection("shops").insertOne({_id:shopId,name:"Wood",out_of_service:true});
  await db.collection("tools").insertOne({_id:toolId,shop_id:shopId,name:"Saw",out_of_service:false});
  await db.collection("nfc_readers").updateOne({_id:readerId},{$set:{role:"tool",toolId}});
  await db.collection("members").updateOne({_id:memberId},{$set:{firstname:"Ada",lastname:"Lovelace",role:"resource_manager",resource_manager_shop_ids:[shopId.toString()]}});
  await db.collection("tool_checkouts").insertOne({tool_id:toolId,member_id:memberId,expires_on:null});
  const response=await call("/reader/v1/snapshot");
  expect(response.status).toBe(200);
  expect(response.body.tool).toMatchObject({enabled:true,available:false,shopOutOfService:true,toolOutOfService:false});
  expect(response.body.grants).toHaveLength(1);
  expect(response.body.cards[0]).toMatchObject({firstName:"Ada",lastInitial:"L",managesTool:true});
  await db.collection("members").updateOne({_id:memberId},{$set:{resource_manager_shop_ids:[]}});
  expect((await call("/reader/v1/cards/lookup",{uid:"00112233"})).body.document.managesTool).toBe(false);
});
test("checkend persists actor and rejects changed replay", async () => {
  const document={_id:new ObjectId().toString(),checkinId:new ObjectId().toString(),uid:"00112233",holder:"Test Member",validity:"activeMember",reader:"test-reader",where:"doorboto32",time:Date.now(),reason:"kicked",kicked:true,kickedBy:{memberId:memberId.toString(),uid:"11223344",holder:"Actor"}};
  expect((await call("/reader/v1/events",{collection:"checkend",document})).status).toBe(200);
  expect((await call("/reader/v1/events",{collection:"checkend",document})).status).toBe(200);
  expect(await client.db("reader_test").collection("checkend").countDocuments()).toBe(1);
  expect((await call("/reader/v1/events",{collection:"checkend",document:{...document,kickedBy:{...document.kickedBy,holder:"Changed"}}})).status).toBe(409);
  expect((await call("/reader/v1/events",{collection:"checkend",document:{...document,_id:new ObjectId().toString(),kickedBy:null}})).status).toBe(422);
});

function endRecord() {
  return {_id:new ObjectId().toString(),checkinId:new ObjectId().toString(),uid:"00112233",
    holder:"Owner",validity:"activeMember",reader:"test-reader",where:"doorboto32",time:0,
    reason:"reboot",kicked:false,kickedBy:null,toolName:"Saw"};
}
test("concurrent identical checkends acknowledge one immutable record", async () => {
  const document=endRecord();
  const results=await Promise.all(Array.from({length:8},()=>call("/reader/v1/events",{collection:"checkend",document})));
  expect(results.map(r=>r.status)).toEqual(Array(8).fill(200));
  expect(await client.db("reader_test").collection("checkend").countDocuments()).toBe(1);
});
test("different event IDs cannot create two endings of the same session", async () => {
  const document=endRecord();
  const results=await Promise.all([document,{...document,_id:new ObjectId().toString()}].map(d=>call("/reader/v1/events",{collection:"checkend",document:d})));
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  expect(await client.db("reader_test").collection("checkend").countDocuments()).toBe(1);
});
test("replay cannot omit previously stored tool context", async () => {
  const document=endRecord();
  expect((await call("/reader/v1/events",{collection:"checkend",document})).status).toBe(200);
  const {toolName,...withoutContext}=document;
  expect((await call("/reader/v1/events",{collection:"checkend",document:withoutContext})).status).toBe(409);
});

test("filter expiry before capacity and include privileged cards in recent snapshots", async () => {
 const db=client.db("reader_test");
 await db.collection("cards").insertMany(Array.from({length:350}, (_,i)=>({uid:(i+100).toString(16).toUpperCase().padStart(8,"0"), member_id:memberId,validity:"activeMember",expiry:1})));
 const full=await call("/reader/v1/snapshot"); expect(full.status).toBe(200); expect(full.body.cards).toHaveLength(1);
 expect((await call("/reader/v1/snapshot/recent",{uids:[]})).body.cards).toHaveLength(0);
 await db.collection("members").updateOne({_id:memberId},{$set:{role:"board_member"}});
 expect((await call("/reader/v1/snapshot/recent",{uids:[]})).body.cards).toHaveLength(1);
 await db.collection("members").updateOne({_id:memberId},{$set:{expirationTime:1}});
 expect((await call("/reader/v1/snapshot/recent",{uids:[]})).body.cards).toHaveLength(0);
 expect((await call("/reader/v1/snapshot/recent",{uids:["bad"]})).status).toBe(422);
});
