import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";
import { toPlainHandler } from "h3";
let repl: MongoMemoryReplSet,
  client: MongoClient,
  handler: any,
  readerId: ObjectId,
  cardId: ObjectId,
  memberId: ObjectId;
const fingerprint = "ab".repeat(32);
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
test("snapshot excludes superseded/revoked checkouts and unavailable tools", async () => {
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
  expect((await call("/reader/v1/snapshot")).body.grants).toHaveLength(0);
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
      })),
    );
  expect((await call("/reader/v1/snapshot")).status).toBe(409);
});
