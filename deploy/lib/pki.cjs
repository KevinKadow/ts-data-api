const {
  fs,
  path,
  assert,
  mkdir,
  write,
  read,
  openssl,
  crypto,
  asnDate,
  twentyYears,
} = require("./core.cjs");

function config(dir) {
  // CA database paths must survive moving/restoring deployment state.
  const base = path.resolve(dir).replace(/\\/g, "/");
  assert(!/[\r\n"$]/.test(base), "Unsupported CA path");
  return `[ca]\ndefault_ca=issuer\n[issuer]\ndir="${base}"\ndatabase=$dir/index.txt\nnew_certs_dir=$dir/issued\ncertificate=$dir/cert.pem\nprivate_key=$dir/key.pem\nserial=$dir/serial\ncrlnumber=$dir/crlnumber\ndefault_md=sha256\ndefault_days=1\ndefault_crl_days=30\npolicy=identity\nunique_subject=no\ncopy_extensions=none\n[identity]\ncommonName=supplied\n`;
}
function refreshConfig(dir) {
  write(path.join(dir, "ca.cnf"), config(dir));
}
function key(file) {
  openssl([
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-out",
    file,
  ]);
  fs.chmodSync(file, 0o600);
}
function extensions(file, kind, sans = []) {
  const value =
    kind === "ca"
      ? "basicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n"
      : `basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${kind === "server" ? "serverAuth" : "clientAuth"}\n`;
  write(
    file,
    "[extensions]\n" +
      value +
      "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n" +
      (sans.length
        ? "subjectAltName=" + sans.map((x) => "DNS:" + x).join(",") + "\n"
        : ""),
  );
}
function makeCA(root, name, validity) {
  const dir = path.join(root, "pki", name);
  mkdir(path.join(dir, "issued"));
  assert(!fs.existsSync(path.join(dir, "key.pem")), "CA already exists");
  write(path.join(dir, "index.txt"), "");
  write(
    path.join(dir, "serial"),
    crypto.randomBytes(16).toString("hex") + "\n",
  );
  write(path.join(dir, "crlnumber"), "01\n");
  refreshConfig(dir);
  key(path.join(dir, "key.pem"));
  openssl([
    "req",
    "-new",
    "-key",
    path.join(dir, "key.pem"),
    "-subj",
    "/CN=" + name,
    "-out",
    path.join(dir, "request.pem"),
  ]);
  extensions(path.join(dir, "extensions.cnf"), "ca");
  openssl([
    "ca",
    "-batch",
    "-selfsign",
    "-config",
    path.join(dir, "ca.cnf"),
    "-in",
    path.join(dir, "request.pem"),
    "-out",
    path.join(dir, "cert.pem"),
    "-notext",
    "-startdate",
    asnDate(validity.start),
    "-enddate",
    asnDate(validity.end),
    "-extensions",
    "extensions",
    "-extfile",
    path.join(dir, "extensions.cnf"),
  ]);
  crl(root, name, validity);
  return name;
}
function crl(root, ca, validity) {
  const dir = path.join(root, "pki", ca);
  refreshConfig(dir);
  // CRLs are refreshed on revocation, and never outlive their issuer.
  openssl([
    "ca",
    "-batch",
    "-config",
    path.join(dir, "ca.cnf"),
    "-gencrl",
    "-crl_nextupdate",
    asnDate(validity.end),
    "-out",
    path.join(dir, "crl.pem"),
  ]);
}
function issue(root, ca, destination, cn, kind, validity, sans = []) {
  const dir = path.join(root, destination),
    issuer = path.join(root, "pki", ca);
  mkdir(dir);
  refreshConfig(issuer);
  assert(
    !fs.existsSync(path.join(dir, "key.pem")),
    "Certificate key already exists",
  );
  key(path.join(dir, "key.pem"));
  openssl([
    "req",
    "-new",
    "-key",
    path.join(dir, "key.pem"),
    "-subj",
    "/CN=" + cn,
    "-out",
    path.join(dir, "request.pem"),
  ]);
  extensions(path.join(dir, "extensions.cnf"), kind, sans);
  openssl([
    "ca",
    "-batch",
    "-rand_serial",
    "-config",
    path.join(issuer, "ca.cnf"),
    "-in",
    path.join(dir, "request.pem"),
    "-out",
    path.join(dir, "cert.pem"),
    "-notext",
    "-startdate",
    asnDate(validity.start),
    "-enddate",
    asnDate(validity.end),
    "-extensions",
    "extensions",
    "-extfile",
    path.join(dir, "extensions.cnf"),
  ]);
  return fingerprint(path.join(dir, "cert.pem"));
}
function fingerprint(file) {
  return new crypto.X509Certificate(read(file)).fingerprint256
    .replace(/:/g, "")
    .toLowerCase();
}
function checkPair(certFile, keyFile) {
  const cert = new crypto.X509Certificate(read(certFile));
  assert(
    cert.checkPrivateKey(crypto.createPrivateKey(read(keyFile))),
    "Certificate/private key mismatch",
  );
  const start = new Date(cert.validFrom),
    end = new Date(cert.validTo);
  assert(
    twentyYears(start).getTime() === end.getTime(),
    "Certificate validity is not exactly 20 calendar years",
  );
  return cert;
}
function validate(root, s) {
  const authorities = [
    { name: s.serverCA, validity: s.serverValidity },
    ...s.readerCAs,
  ];
  for (const ca of authorities) {
    const dir = path.join(root, "pki", ca.name);
    const cert = checkPair(
      path.join(dir, "cert.pem"),
      path.join(dir, "key.pem"),
    );
    assert(cert.ca, "Issuer is not a CA");
    assert(
      Date.parse(cert.validFrom) === Date.parse(ca.validity.start) &&
        Date.parse(cert.validTo) === Date.parse(ca.validity.end),
      "CA dates disagree with state",
    );
    for (const file of ["index.txt", "serial", "crlnumber", "crl.pem"])
      assert(
        fs.existsSync(path.join(dir, file)),
        "CA recovery state is incomplete",
      );
    openssl([
      "verify",
      "-CAfile",
      path.join(dir, "cert.pem"),
      path.join(dir, "cert.pem"),
    ]);
  }
  const certificates = [
    {
      dir: "certificates/api",
      ca: s.serverCA,
      hosts: [s.config.apiHost, "*." + s.config.managementDomain],
      purpose: "sslserver",
    },
    {
      dir: "certificates/broker",
      ca: s.serverCA,
      hosts: [s.config.mqttHost, s.config.mqttServiceHost, "mosquitto"],
      purpose: "sslserver",
    },
    ...s.readers.map((r) => ({
      dir: "readers/" + r.id,
      ca: r.ca,
      purpose: "sslclient",
      reader: r,
    })),
  ];
  for (const item of certificates) {
    const dir = path.join(root, item.dir),
      cert = checkPair(path.join(dir, "cert.pem"), path.join(dir, "key.pem"));
    for (const host of item.hosts || [])
      assert(cert.checkHost(host), "Certificate SAN missing");
    if (item.reader)
      assert(
        fingerprint(path.join(dir, "cert.pem")) ===
          item.reader.certificateFingerprint &&
          cert.subject === "CN=" + item.reader.id,
        "Reader certificate identity mismatch",
      );
    openssl([
      "verify",
      "-purpose",
      item.purpose,
      "-CAfile",
      path.join(root, "pki", item.ca, "cert.pem"),
      path.join(dir, "cert.pem"),
    ]);
    const caCert = new crypto.X509Certificate(
      read(path.join(root, "pki", item.ca, "cert.pem")),
    );
    assert(
      Date.parse(cert.validTo) <= Date.parse(caCert.validTo),
      "Leaf certificate outlives issuer",
    );
  }
}
function revoke(root, r, validity) {
  const dir = path.join(root, "pki", r.ca);
  refreshConfig(dir);
  const serial = new crypto.X509Certificate(
    read(path.join(root, "readers", r.id, "cert.pem")),
  ).serialNumber;
  const already = read(path.join(dir, "index.txt"))
    .split("\n")
    .some(
      (line) =>
        line.startsWith("R\t") &&
        line.split("\t")[3]?.toUpperCase() === serial.toUpperCase(),
    );
  if (!already)
    openssl([
      "ca",
      "-batch",
      "-config",
      path.join(dir, "ca.cnf"),
      "-revoke",
      path.join(root, "readers", r.id, "cert.pem"),
      "-crl_reason",
      "keyCompromise",
    ]);
  crl(root, r.ca, validity);
}
module.exports = {
  makeCA,
  issue,
  crl,
  revoke,
  validate,
  refreshConfig,
  fingerprint,
  checkPair,
};
