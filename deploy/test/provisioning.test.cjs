const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { Readable } = require("node:stream");
const c = require("../lib/core.cjs");
const pki = require("../lib/pki.cjs");
const ops = require("../lib/operations.cjs");
const recovery = require("../lib/recovery.cjs");
const { render } = require("../lib/render.cjs");
const { parse } = require("../cli.cjs");
const { fs, path } = c;
const tempBase = process.env.DEPLOY_TEST_TMP || os.tmpdir();
c.mkdir(tempBase);
const tmp = fs.mkdtempSync(path.join(tempBase, "reader-deploy-test-"));
const root = path.join(tmp, "state");
c.mkdir(root);
const config = { ...require("../deployment.example.json") };
const input = path.join(tmp, "config.json");
c.json(input, config);
const uri = path.join(tmp, "uri");
c.write(uri, "mongodb://127.0.0.1:27017/test");
let s;
test.after(() => {
  // Files written read-only by render require clearing that attribute on Windows.
  for (const file of c.files(tmp)) fs.chmodSync(path.join(tmp, file), 0o600);
  fs.rmSync(tmp, { recursive: true, force: true });
});
test("initialization issues separate complete 20-year server/client authorities", () => {
  s = ops.init(root, { config: input, mongoUriFile: uri });
  ops.validateState(root, s);
  const ca = new c.crypto.X509Certificate(
    c.read(path.join(root, "pki/server-root/cert.pem")),
  );
  assert.equal(
    Date.parse(ca.validTo),
    c.twentyYears(new Date(ca.validFrom)).getTime(),
  );
  assert.notEqual(
    c.read(path.join(root, "pki/server-root/key.pem")),
    c.read(path.join(root, "pki/reader-root/key.pem")),
  );
  assert.throws(
    () => ops.init(root, { config: input, mongoUriFile: uri }),
    /empty state/,
  );
});
test("calendar validity handles leap-century dates and timestamps beyond 2038", () => {
  assert.equal(
    c.twentyYears(new Date("2080-02-29T12:34:56Z")).toISOString(),
    "2100-02-28T12:34:56.000Z",
  );
  const ca = path.join(root, "pki/server-root/cert.pem");
  const nearExpiry = Math.floor(Date.parse(s.serverValidity.end) / 1000) - 1;
  c.openssl([
    "verify",
    "-attime",
    String(nearExpiry),
    "-CAfile",
    ca,
    path.join(root, "certificates/api/cert.pem"),
  ]);
  assert.throws(() =>
    c.openssl([
      "verify",
      "-attime",
      String(nearExpiry + 2),
      "-CAfile",
      ca,
      path.join(root, "certificates/api/cert.pem"),
    ]),
  );
});
test("readers get independent identities and compile headers without master secrets", () => {
  for (const board of ["waveshare", "olimex", "qtpy"]) {
    const reader = {
      ...require("../reader.example.json"),
      name: board,
      board,
      managementHost: board + "." + config.managementDomain,
    };
    if (board === "qtpy")
      Object.assign(reader, {
        wifiSsid: "fixture-network",
        wifiPsk: "fixture-password",
      });
    const file = path.join(tmp, "reader.json");
    c.json(file, reader);
    ops.addReader(root, { readerFile: file });
  }
  s = c.state(root);
  ops.validateState(root, s);
  assert.equal(new Set(s.readers.map((r) => r.id)).size, 3);
  assert.equal(new Set(s.readers.map((r) => r.certificateFingerprint)).size, 3);
  for (const r of s.readers) {
    const header = c.read(path.join(root, "readers", r.id, "secrets.h"));
    assert.match(header, new RegExp(r.id));
    assert.match(header, /#define READER_PRODUCTION 0/);
    for (const forbidden of [
      s.secrets.mongoUri,
      s.secrets.cardKey,
      s.secrets.proxy,
      s.secrets.jwt,
      s.secrets.reservations,
    ])
      assert.ok(!header.includes(forbidden));
    assert.ok(
      !header.includes(
        c.read(path.join(root, "pki/server-root/key.pem")).trim(),
      ),
    );
    assert.ok(!/^#define CACHE_KEY_HEX/m.test(header));
  }
});
test("render is deterministic and does not rotate any credential", () => {
  const before = Object.fromEntries(
    c.files(root).map((f) => [f, c.sha(fs.readFileSync(path.join(root, f)))]),
  );
  render(root, c.state(root));
  const after = Object.fromEntries(
    c.files(root).map((f) => [f, c.sha(fs.readFileSync(path.join(root, f)))]),
  );
  assert.deepEqual(after, before);
});
test("TLS purpose, SAN and revocation are enforced by actual OpenSSL", () => {
  const r = s.readers[0],
    cert = path.join(root, "readers", r.id, "cert.pem"),
    ca = path.join(root, "pki", r.ca, "cert.pem");
  c.openssl(["verify", "-purpose", "sslclient", "-CAfile", ca, cert]);
  assert.throws(() =>
    c.openssl(["verify", "-purpose", "sslserver", "-CAfile", ca, cert]),
  );
  assert.throws(() =>
    c.openssl([
      "verify",
      "-verify_hostname",
      "wrong.example.org",
      "-CAfile",
      path.join(root, "pki/server-root/cert.pem"),
      path.join(root, "certificates/api/cert.pem"),
    ]),
  );
  pki.revoke(root, r, s.readerCAs.find((x) => x.name === r.ca).validity);
  assert.throws(() =>
    c.openssl([
      "verify",
      "-crl_check",
      "-CRLfile",
      path.join(root, "pki", r.ca, "crl.pem"),
      "-CAfile",
      ca,
      cert,
    ]),
  );
  // Retry revocation is idempotent.
  pki.revoke(root, r, s.readerCAs.find((x) => x.name === r.ca).validity);
});
test("configuration rejects injection, ambiguous identities and unbounded management networks", () => {
  assert.throws(() =>
    c.validateConfig({ ...config, apiHost: "api.example.org\nfoo" }),
  );
  assert.throws(() =>
    c.validateConfig({ ...config, managementAllowedCidrs: ["0.0.0.0/0"] }),
  );
  for (const cidr of ["192.168.1.0/8", "172.16.0.0/8", "10.0.0.0/8/0"])
    assert.throws(() =>
      c.validateConfig({ ...config, managementAllowedCidrs: [cidr] }),
    );
  assert.throws(() =>
    c.validateReader(
      { ...require("../reader.example.json"), board: "qtpy" },
      config,
    ),
  );
  assert.throws(() => parse(["init", "--config"]));
  assert.throws(() => parse(["init", "--unknown", "foo"]));
});
test("isolated restore preserves compiled names but rejects production targets", () => {
  assert.throws(() =>
    recovery.isolated(
      structuredClone(s),
      structuredClone(config),
      "mongodb://test:27017/test",
    ),
  );
  const target = {
    ...config,
    name: "reader-test",
    database: "reader_test",
    readerBindAddress: "192.168.50.10",
    managementBindAddress: "192.168.60.10",
    managementAllowedCidrs: ["192.168.60.0/24"],
    railsUrl: "https://test-rails.example.org",
  };
  const result = recovery.isolated(
    structuredClone(s),
    target,
    "mongodb://127.0.0.1:27017/test",
  );
  assert.deepEqual(result.readers, s.readers);
  assert.equal(result.secrets.cardKey, s.secrets.cardKey);
  assert.throws(() =>
    recovery.isolated(
      structuredClone(s),
      { ...target, apiHost: "changed.example.org" },
      "mongodb://test:27017",
    ),
  );
});
test("archive parser rejects traversal and symlink entries before extraction", async () => {
  for (const name of ["../escape", "C:/escape", "nested/../../escape"])
    assert.throws(() => c.safeFile(tmp, name));
  const header = recovery.header("recovery-manifest.json", 1);
  header[156] = 50;
  await assert.rejects(() =>
    recovery.unpack(
      Readable.from([header, Buffer.from("x"), Buffer.alloc(1024)]),
      path.join(tmp, "malicious"),
    ),
  );
});
test("encrypted round-trip preserves private keys, identities and card master key", async () => {
  const keygen = process.env.AGE_KEYGEN || "age-keygen";
  const identity = path.join(tmp, "identity.txt");
  c.run(keygen, ["-o", identity]);
  const recipient = c.run(keygen, ["-y", identity]).trim();
  const archive = path.join(tmp, "recovery.tar.age");
  await recovery.exportState(root, { output: archive, recipient });
  assert.ok(!fs.readFileSync(archive).includes(Buffer.from(s.secrets.cardKey)));
  const restored = path.join(tmp, "restored");
  c.mkdir(restored);
  const result = await recovery.restoreState(restored, {
    input: archive,
    identity,
    mode: "rebuild",
  });
  assert.deepEqual(result, s);
  for (const relative of c.files(root))
    assert.deepEqual(
      fs.readFileSync(path.join(restored, relative)),
      fs.readFileSync(path.join(root, relative)),
      relative,
    );
  await assert.rejects(
    () =>
      recovery.restoreState(restored, {
        input: archive,
        identity,
        mode: "rebuild",
      }),
    /empty/,
  );
  const wrong = path.join(tmp, "wrong.txt");
  c.run(keygen, ["-o", wrong]);
  const failed = path.join(tmp, "failed");
  c.mkdir(failed);
  await assert.rejects(() =>
    recovery.restoreState(failed, {
      input: archive,
      identity: wrong,
      mode: "rebuild",
    }),
  );
  assert.deepEqual(fs.readdirSync(failed), []);
  const corrupt = path.join(tmp, "corrupt.tar.age"),
    bytes = fs.readFileSync(archive);
  bytes[bytes.length - 40] ^= 1;
  fs.writeFileSync(corrupt, bytes);
  await assert.rejects(() =>
    recovery.restoreState(failed, {
      input: corrupt,
      identity,
      mode: "rebuild",
    }),
  );
  assert.deepEqual(fs.readdirSync(failed), []);
});
test("incomplete recovery state fails instead of generating replacement secrets", async () => {
  const malformed = path.join(tmp, "incomplete");
  c.mkdir(malformed);
  for (const f of c.files(root)) {
    c.write(path.join(malformed, f), fs.readFileSync(path.join(root, f)));
  }
  fs.unlinkSync(path.join(malformed, "pki/server-root/key.pem"));
  assert.throws(() => ops.validateState(malformed, c.state(malformed)));
});
