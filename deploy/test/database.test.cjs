const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, ObjectId } = require("mongodb");
const c = require("../lib/core.cjs");
const ops = require("../lib/operations.cjs");
const recovery = require("../lib/recovery.cjs");
const { fs, path } = c;
let repl, client, root, s, tmp, cardId, memberId, material;
test.before(async () => {
  const base = process.env.DEPLOY_TEST_TMP || os.tmpdir();
  c.mkdir(base);
  tmp = fs.mkdtempSync(path.join(base, "reader-db-test-"));
  root = path.join(tmp, "state");
  c.mkdir(root);
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = await MongoClient.connect(repl.getUri());
  const config = {
    ...require("../deployment.example.json"),
    database: "reader_fixture",
  };
  c.json(path.join(tmp, "config.json"), config);
  c.write(path.join(tmp, "uri"), repl.getUri());
  s = ops.init(root, {
    config: path.join(tmp, "config.json"),
    mongoUriFile: path.join(tmp, "uri"),
  });
  c.json(path.join(tmp, "reader.json"), require("../reader.example.json"));
  ops.addReader(root, { readerFile: path.join(tmp, "reader.json") });
  s = c.state(root);
  await client
    .db(config.database)
    .collection("cards")
    .createIndex({ uid: 1 }, { unique: true });
  await ops.indexes(root);
  await ops.registerReaders(root);
  cardId = new ObjectId();
  memberId = new ObjectId();
  material = {
    keyA: "ab".repeat(6),
    keyB: "cd".repeat(6),
    contents: "ef".repeat(48),
    digest: "12".repeat(32),
    version: 1,
  };
  const iv = c.crypto.randomBytes(12),
    cipher = c.crypto.createCipheriv(
      "aes-256-gcm",
      Buffer.from(s.secrets.cardKey, "base64"),
      iv,
    );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(material)),
    cipher.final(),
  ]);
  const db = client.db(config.database);
  await db.collection("members").insertOne({ _id: memberId, status: "active" });
  await db
    .collection("cards")
    .insertOne({ _id: cardId, uid: "00112233", member_id: memberId });
  await db.collection("nfc_card_credentials").insertOne({
    _id: cardId,
    memberId,
    uid: "00112233",
    state: "active",
    sealed: {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
  });
});
test.after(async () => {
  await client?.close();
  await repl?.stop();
  if (tmp) {
    for (const f of c.files(tmp)) fs.chmodSync(path.join(tmp, f), 0o600);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("registration and indexing reruns preserve identity and enrollment data", async () => {
  const db = client.db(s.config.database),
    before = await db.collection("nfc_readers").findOne({});
  await ops.registerReaders(root);
  await ops.indexes(root);
  assert.deepEqual(await db.collection("nfc_readers").findOne({}), before);
  assert.equal(await db.collection("nfc_card_credentials").countDocuments(), 1);
  await ops.credentialCheck(db, s);
});
test("wrong card master key fails without changing existing records", async () => {
  const wrong = structuredClone(s);
  wrong.secrets.cardKey = c.crypto.randomBytes(32).toString("base64");
  await assert.rejects(
    () => ops.credentialCheck(client.db(s.config.database), wrong),
    /original encryption key/,
  );
});
test("conflicting reader registrations fail instead of overwriting live configuration", async () => {
  const db = client.db(s.config.database);
  await db
    .collection("nfc_readers")
    .updateOne({}, { $set: { name: "renamed-live" } });
  await assert.rejects(
    () => ops.registerReaders(root),
    /refusing to overwrite/,
  );
  await db
    .collection("nfc_readers")
    .updateOne({}, { $set: { name: s.readers[0].name } });
});
test("revocation disables Mongo identity and retains immutable reader identity", async () => {
  const before = await client
    .db(s.config.database)
    .collection("nfc_readers")
    .findOne({});
  await ops.revokeReader(root, { reader: s.readers[0].id });
  const after = await client
    .db(s.config.database)
    .collection("nfc_readers")
    .findOne({});
  assert.equal(after.enabled, false);
  assert.equal(String(after._id), String(before._id));
  assert.equal(after.reservationCoverageRevision, 1);
  s = c.state(root);
});
test("encryption key plus BSON snapshot can be restored to isolation without re-enrollment", async (t) => {
  // Exercise real mongodump/mongorestore when Database Tools are installed (CI).
  const hasTools = (() => {
    try {
      c.run("mongodump", ["--version"]);
      c.run("mongorestore", ["--version"]);
      return true;
    } catch {
      return false;
    }
  })();
  if (!hasTools) {
    t.skip(
      "MongoDB Database Tools unavailable; full archive restore runs in CI",
    );
    return;
  }
  const archive = path.join(tmp, "database.archive");
  await ops.backupDB(root, { output: archive, writersPaused: true });
  const identity = path.join(tmp, "identity");
  c.run(process.env.AGE_KEYGEN || "age-keygen", ["-o", identity]);
  const recipient = c
    .run(process.env.AGE_KEYGEN || "age-keygen", ["-y", identity])
    .trim();
  const exported = path.join(tmp, "state.tar.age");
  await recovery.exportState(root, {
    output: exported,
    recipient,
    databaseArchive: archive,
  });
  const target = {
    ...s.config,
    name: "reader-restore-test",
    database: "reader_restored",
    readerBindAddress: "192.168.50.10",
    managementBindAddress: "192.168.60.10",
    managementAllowedCidrs: ["192.168.60.0/24"],
    railsUrl: "https://test-rails.example.org",
  };
  c.json(path.join(tmp, "target.json"), target);
  const restored = path.join(tmp, "restored");
  c.mkdir(restored);
  await recovery.restoreState(restored, {
    input: exported,
    identity,
    mode: "isolated-test",
    config: path.join(tmp, "target.json"),
    mongoUriFile: path.join(tmp, "uri"),
  });
  await ops.restoreDB(restored, {});
  const db = client.db(target.database),
    newState = c.state(restored);
  await ops.credentialCheck(db, newState);
  assert.equal(
    String((await db.collection("cards").findOne({ uid: "00112233" }))._id),
    String(cardId),
  );
  assert.equal(
    String((await db.collection("nfc_readers").findOne({}))._id),
    s.readers[0].id,
  );
  assert.deepEqual(
    (await db.collection("nfc_card_credentials").findOne({})).sealed,
    (
      await client
        .db(s.config.database)
        .collection("nfc_card_credentials")
        .findOne({})
    ).sealed,
  );
  await assert.rejects(() => ops.restoreDB(restored, {}), /not empty/);
  const nextExport = await recovery.exportState(restored, {
    output: path.join(tmp, "restored-keys.tar.age"),
    recipient,
  });
  assert.ok(nextExport.files.every((file) => !file.path.startsWith("backup/")));
  await assert.rejects(
    () =>
      recovery.exportState(restored, {
        output: path.join(tmp, "wrong-database.tar.age"),
        recipient,
        databaseArchive: archive,
      }),
    /consistency metadata/,
  );
});
