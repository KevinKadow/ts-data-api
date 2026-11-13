const { MongoClient, ObjectId } = require("mongodb");
const https = require("node:https");
const tls = require("node:tls");
const {
  fs,
  path,
  crypto,
  sha,
  assert,
  mkdir,
  write,
  json,
  read,
  readJSON,
  run,
  random,
  state,
  validateConfig,
  validateReader,
  interval,
} = require("./core.cjs");
const pki = require("./pki.cjs");
const { render, passwordHash } = require("./render.cjs");
const { hashFile } = require("./recovery.cjs");

function save(root, s) {
  json(path.join(root, "state.json"), s);
}
function secretFile(file) {
  assert(file, "A secret input file is required");
  const value = read(file).trim();
  assert(value, "Secret input is empty");
  return value;
}
function validateState(root, s) {
  validateConfig(s.config);
  assert(/^[a-f0-9]{32}$/.test(s.deploymentId), "Invalid deployment identity");
  assert(
    /^[a-zA-Z0-9_-]+$/.test(s.serverCA) &&
      Array.isArray(s.readerCAs) &&
      s.readerCAs.length > 0,
    "Invalid CA inventory",
  );
  for (const ca of s.readerCAs)
    assert(/^[a-zA-Z0-9_-]+$/.test(ca.name), "Invalid reader CA identity");
  assert(
    s.secrets && /^mongodb(?:\+srv)?:\/\//.test(s.secrets.mongoUri),
    "MongoDB connection secret is missing",
  );
  for (const key of ["jwt", "proxy", "mqttApi", "mqttRails"])
    assert(
      typeof s.secrets[key] === "string" &&
        /^[A-Za-z0-9_+\/=-]{32,512}$/.test(s.secrets[key]),
      `Invalid ${key} secret`,
    );
  assert(
    typeof s.secrets.reservations === "string" &&
      /^[\x20-\x7e]{32,512}$/.test(s.secrets.reservations),
    "Invalid reservation service secret",
  );
  assert(
    typeof s.secrets.cardKey === "string" &&
      Buffer.from(s.secrets.cardKey, "base64").length === 32 &&
      Buffer.from(s.secrets.cardKey, "base64").toString("base64") ===
        s.secrets.cardKey,
    "Card-encryption key must be canonical Base64 for 32 bytes",
  );
  for (const key of ["mqttApiHash", "mqttRailsHash"])
    assert(
      /^\$7\$[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(s.secrets[key]),
      "Missing MQTT password hashes",
    );
  const ids = new Set(),
    names = new Set(),
    hosts = new Set();
  for (const r of s.readers) {
    validateReader(r, s.config);
    assert(
      /^[a-f0-9]{24}$/.test(r.id) &&
        /^[a-f0-9]{64}$/.test(r.certificateFingerprint),
      "Invalid reader identity",
    );
    assert(
      !ids.has(r.id) && !names.has(r.name) && !hosts.has(r.managementHost),
      "Duplicate reader inventory",
    );
    ids.add(r.id);
    names.add(r.name);
    hosts.add(r.managementHost);
    assert(
      s.readerCAs.some((ca) => ca.name === r.ca),
      "Missing reader authority",
    );
    assert(
      r.webUsername === "admin" &&
        typeof r.webPassword === "string" &&
        r.webPassword.length >= 32,
      "Missing management credentials",
    );
    assert(
      fs.existsSync(path.join(root, "readers", r.id, "secrets.h")),
      "Missing exported firmware configuration",
    );
  }
  if (s.additionalServerCA)
    assert(
      read(path.join(root, "additional-server-ca.pem")).includes(
        "BEGIN CERTIFICATE",
      ),
      "Missing additional CA bundle",
    );
  assert(
    s.images && s.sourceRevision && /^[a-zA-Z0-9_.-]+$/.test(s.sourceRevision),
    "Missing build provenance",
  );
  pki.validate(root, s);
}
function init(root, o) {
  assert(
    fs.readdirSync(root).every((x) => x === ".lock"),
    "Initialization requires empty state; use restore/render to rebuild",
  );
  const c = validateConfig(readJSON(o.config)),
    uri = secretFile(o.mongoUriFile);
  assert(
    /^mongodb(?:\+srv)?:\/\//.test(uri),
    "Expected a MongoDB URI input file",
  );
  const stage = path.join(root, ".init-stage");
  mkdir(stage);
  try {
    const validity = interval(),
      s = {
        version: 1,
        deploymentId: crypto.randomBytes(16).toString("hex"),
        config: c,
        sourceRevision: process.env.DEPLOY_REVISION || "local",
        images: readJSON(path.join(__dirname, "../images.json")),
        serverCA: "server-root",
        serverValidity: validity,
        readerCAs: [{ name: "reader-root", validity }],
        readers: [],
        databaseBinding: null,
        secrets: {
          mongoUri: uri,
          jwt: random(),
          proxy: random(),
          cardKey: o.cardKeyFile
            ? secretFile(o.cardKeyFile)
            : crypto.randomBytes(32).toString("base64"),
          reservations: o.railsSecretFile
            ? secretFile(o.railsSecretFile)
            : random(),
          mqttApi: random(),
          mqttRails: random(),
        },
      };
    s.secrets.mqttApiHash = passwordHash(s.secrets.mqttApi);
    s.secrets.mqttRailsHash = passwordHash(s.secrets.mqttRails);
    if (o.additionalCaFile) {
      const ca = read(o.additionalCaFile);
      assert(
        ca.includes("BEGIN CERTIFICATE") && !ca.includes("PRIVATE KEY"),
        "Additional CA file must contain public certificates only",
      );
      write(path.join(stage, "additional-server-ca.pem"), ca);
      s.additionalServerCA = true;
    }
    pki.makeCA(stage, s.serverCA, validity);
    pki.makeCA(stage, "reader-root", validity);
    pki.issue(
      stage,
      s.serverCA,
      "certificates/api",
      c.apiHost,
      "server",
      validity,
      [c.apiHost, "*." + c.managementDomain],
    );
    pki.issue(
      stage,
      s.serverCA,
      "certificates/broker",
      c.mqttHost,
      "server",
      validity,
      [c.mqttHost, c.mqttServiceHost, "mosquitto"],
    );
    render(stage, s);
    save(stage, s);
    validateState(stage, s);
    for (const name of fs.readdirSync(stage))
      fs.renameSync(path.join(stage, name), path.join(root, name));
    fs.rmdirSync(stage);
    return s;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
function addReader(root, o) {
  const s = state(root),
    r = validateReader(readJSON(o.readerFile), s.config);
  validateState(root, s);
  assert(
    !s.readers.some(
      (x) => x.name === r.name || x.managementHost === r.managementHost,
    ),
    "Reader already exists; use render to recover its header",
  );
  r.id = new ObjectId().toHexString();
  r.webUsername = "admin";
  r.webPassword = random();
  r.revoked = false;
  const validity = interval(),
    ca = "reader-" + r.id;
  // Each later issuance is a complete 20-year batch, including its issuer.
  r.ca = ca;
  try {
    pki.makeCA(root, ca, validity);
    r.certificateFingerprint = pki.issue(
      root,
      ca,
      "readers/" + r.id,
      r.id,
      "client",
      validity,
    );
    s.readerCAs.push({ name: ca, validity });
    s.readers.push(r);
    render(root, s);
    save(root, s);
    return r.id;
  } catch (error) {
    // Keep partial evidence for explicit operator recovery; never overwrite keys on retry.
    write(path.join(root, ".incomplete-add-reader"), r.id + "\n");
    throw error;
  }
}
function connection(s) {
  return new MongoClient(s.secrets.mongoUri, {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    writeConcern: { w: "majority" },
    readPreference: "primary",
  });
}
async function withDB(s, fn) {
  const client = connection(s);
  try {
    return await fn(client.db(s.config.database), client);
  } finally {
    await client.close();
  }
}
async function credentialCheck(db, s) {
  const key = Buffer.from(s.secrets.cardKey, "base64");
  for await (const row of db
    .collection("nfc_card_credentials")
    .find({}, { projection: { sealed: 1 } })) {
    try {
      const d = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(row.sealed.iv, "base64"),
      );
      d.setAuthTag(Buffer.from(row.sealed.tag, "base64"));
      JSON.parse(
        Buffer.concat([
          d.update(Buffer.from(row.sealed.ciphertext, "base64")),
          d.final(),
        ]).toString(),
      );
    } catch {
      throw Error(
        "Existing card credentials cannot be decrypted: restore their original encryption key; do not reinitialize cards",
      );
    }
  }
}
async function duplicateCheck(db) {
  for (const [collection, fields, match] of [
    ["nfc_readers", ["name"], {}],
    ["nfc_readers", ["certificateFingerprint"], {}],
    ["checkend", ["deviceId", "checkinId"], { checkinId: { $type: "string" } }],
    ["cards", ["uid"], {}],
  ]) {
    const rows = await db
      .collection(collection)
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: Object.fromEntries(fields.map((f) => [f, "$" + f])),
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 },
      ])
      .toArray();
    assert(
      !rows.length,
      `Duplicate ${collection} ${fields.join("/")} values; review records before indexing`,
    );
  }
}
async function indexes(root) {
  const s = state(root);
  validateState(root, s);
  await withDB(s, async (db) => {
    await credentialCheck(db, s);
    await duplicateCheck(db);
  });
  run(
    process.execPath,
    [path.join(__dirname, "../../scripts/reader-indexes.cjs")],
    {
      env: {
        ...process.env,
        DATA_SOURCES: JSON.stringify({
          [s.config.dataSource]: s.secrets.mongoUri,
        }),
        READER_DATA_SOURCE: s.config.dataSource,
        READER_DATABASE: s.config.database,
      },
    },
  );
}
async function checkIndexes(db) {
  const checks = [
    ["nfc_readers", { name: 1 }],
    ["nfc_readers", { certificateFingerprint: 1 }],
    ["cards", { uid: 1 }],
    ["checkend", { deviceId: 1, checkinId: 1 }],
  ];
  for (const [collection, key] of checks) {
    let indexes = [];
    try {
      indexes = await db.collection(collection).listIndexes().toArray();
    } catch (e) {
      if (e.code !== 26) throw e;
    }
    assert(
      indexes.some(
        (i) =>
          i.unique &&
          JSON.stringify(i.key) === JSON.stringify(key) &&
          (collection !== "checkend" ||
            i.name === "one_end_per_reader_checkin"),
      ),
      `Missing unique index on ${collection}; deploy reader indexes and the Rails cards.uid index`,
    );
  }
}
async function registerReaders(root) {
  const s = state(root);
  validateState(root, s);
  await withDB(s, async (db) => {
    await credentialCheck(db, s);
    await checkIndexes(db);
    for (const r of s.readers) {
      if (r.revoked) continue;
      if (r.role === "tool")
        assert(
          await db.collection("tools").findOne({ _id: new ObjectId(r.toolId) }),
          "Registered tool does not exist",
        );
      const doc = {
        _id: new ObjectId(r.id),
        name: r.name,
        certificateFingerprint: r.certificateFingerprint,
        enabled: true,
        role: r.role,
        toolId: r.toolId ? new ObjectId(r.toolId) : null,
        where: r.where,
        enrollmentEnabled: false,
      };
      const old = await db.collection("nfc_readers").findOne({ _id: doc._id });
      if (old) {
        assert(
          ["name", "certificateFingerprint", "enabled", "role", "where"].every(
            (k) => old[k] === doc[k],
          ) && String(old.toolId || "") === String(doc.toolId || ""),
          "Existing reader differs; refusing to overwrite its configuration",
        );
      } else await db.collection("nfc_readers").insertOne(doc);
    }
  });
}
function caBundle(root, s) {
  return [
    ...tls.rootCertificates,
    read(path.join(root, "pki", s.serverCA, "cert.pem")),
    ...(s.additionalServerCA
      ? [read(path.join(root, "additional-server-ca.pem"))]
      : []),
  ];
}
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...options, timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body) > 600000)
          req.destroy(Error("Response exceeds verification bound"));
      });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(Error("HTTPS verification timeout")));
    req.on("error", () =>
      reject(Error("HTTPS connectivity or certificate verification failed")),
    );
    if (options.body) req.write(options.body);
    req.end();
  });
}
async function preflight(root, o) {
  const s = state(root);
  validateState(root, s);
  assert(
    !fs.existsSync(path.join(root, ".incomplete-add-reader")),
    "Resolve incomplete reader generation before deployment",
  );
  // Docker Desktop bind mounts can report 0777 despite restrictive host ACLs.
  // The Windows wrapper verifies/sets those ACLs before launching this container.
  if (
    process.platform !== "win32" &&
    process.env.DEPLOY_HOST_PLATFORM !== "windows"
  ) {
    assert(
      (fs.statSync(root).mode & 0o077) === 0,
      "Deployment state directory must have mode 0700",
    );
    assert(
      (fs.statSync(path.join(root, "state.json")).mode & 0o077) === 0,
      "State file must have mode 0600",
    );
  }
  if (o.offline) return;
  await withDB(s, async (db, client) => {
    const hello = await client.db("admin").command({ hello: 1 });
    assert(
      hello.setName || hello.msg === "isdbgrid",
      "MongoDB must be a replica set or Atlas sharded deployment",
    );
    await credentialCheck(db, s);
    await duplicateCheck(db);
    if (!o.beforeIndexes) await checkIndexes(db);
  });
  await request(s.config.railsUrl, { ca: caBundle(root, s) });
  s.databaseBinding = {
    database: s.config.database,
    checkedAt: new Date().toISOString(),
  };
  save(root, s);
}
async function revokeReader(root, o) {
  const s = state(root),
    r = s.readers.find((r) => r.id === o.reader || r.name === o.reader);
  assert(r, "Unknown reader");
  await withDB(s, (db) =>
    db
      .collection("nfc_readers")
      .updateOne(
        { _id: new ObjectId(r.id), enabled: { $ne: false } },
        { $set: { enabled: false }, $inc: { reservationCoverageRevision: 1 } },
      ),
  );
  // Persist disabled state first: a later render can never re-enable this identity.
  r.revoked = true;
  save(root, s);
  pki.revoke(root, r, s.readerCAs.find((c) => c.name === r.ca).validity);
  render(root, s);
}
async function backupDB(root, o) {
  const s = state(root);
  validateState(root, s);
  assert(
    o.writersPaused,
    "Stop ALL database writers (Rails/jobs/API/other clients), then pass --writers-paused",
  );
  assert(
    o.output && !fs.existsSync(o.output) && !fs.existsSync(o.output + ".json"),
    "Choose a new database archive output",
  );
  const config = path.join(
      require("node:os").tmpdir(),
      "mongo-" + crypto.randomUUID() + ".yml",
    ),
    partial = o.output + ".partial";
  assert(!fs.existsSync(partial), "Partial database archive already exists");
  await withDB(s, (db) => credentialCheck(db, s));
  try {
    write(config, "uri: " + JSON.stringify(s.secrets.mongoUri) + "\n");
    run("mongodump", [
      "--config",
      config,
      "--db",
      s.config.database,
      "--archive=" + partial,
    ]);
    fs.chmodSync(partial, 0o600);
    fs.renameSync(partial, o.output);
    json(o.output + ".json", {
      version: 1,
      deploymentId: s.deploymentId,
      database: s.config.database,
      cardKeyFingerprint: sha(Buffer.from(s.secrets.cardKey, "base64")),
      consistency: "writers-paused",
      createdAt: new Date().toISOString(),
      sha256: await hashFile(o.output),
    });
  } finally {
    fs.rmSync(config, { force: true });
    fs.rmSync(partial, { force: true });
  }
}
async function restoreDB(root, o) {
  const s = state(root);
  assert(
    s.restoredFrom?.mode === "isolated-test",
    "restore-db is restricted to isolated-test mode; use managed backup recovery for production",
  );
  assert(
    s.config.database !== s.restoredFrom.config.database &&
      s.config.railsUrl !== s.restoredFrom.config.railsUrl,
    "Test targets must differ from production",
  );
  const receipt = readJSON(path.join(root, "restore-receipt.json"));
  const file = path.join(root, "backup/database.archive"),
    meta = receipt.databaseSnapshot;
  assert(
    meta?.consistency === "writers-paused" &&
      meta.database === s.restoredFrom.config.database &&
      meta.cardKeyFingerprint ===
        sha(Buffer.from(s.secrets.cardKey, "base64")) &&
      (await hashFile(file)) === meta.sha256,
    "Missing consistent bundled database archive",
  );
  await withDB(s, async (db) =>
    assert(
      (await db.listCollections().toArray()).length === 0,
      "Test database is not empty; refusing restore",
    ),
  );
  const config = path.join(
    require("node:os").tmpdir(),
    "mongo-" + crypto.randomUUID() + ".yml",
  );
  try {
    write(config, "uri: " + JSON.stringify(s.secrets.mongoUri) + "\n");
    run("mongorestore", [
      "--config",
      config,
      "--archive=" + file,
      "--nsInclude=" + meta.database + ".*",
      "--nsFrom=" + meta.database + ".*",
      "--nsTo=" + s.config.database + ".*",
      "--stopOnError",
    ]);
    await withDB(s, (db) => credentialCheck(db, s));
  } finally {
    fs.rmSync(config, { force: true });
  }
}
module.exports = {
  init,
  addReader,
  validateState,
  save,
  secretFile,
  withDB,
  credentialCheck,
  duplicateCheck,
  checkIndexes,
  indexes,
  registerReaders,
  preflight,
  revokeReader,
  backupDB,
  restoreDB,
  request,
  caBundle,
};
