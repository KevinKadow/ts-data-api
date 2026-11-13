const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

function assert(ok, message) {
  if (!ok) throw Error(message);
}
function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
function write(file, value, mode = 0o600) {
  mkdir(path.dirname(file));
  const temp = file + ".tmp";
  fs.writeFileSync(temp, value, { mode });
  fs.chmodSync(temp, mode);
  // Windows cannot replace a file carrying the read-only attribute.
  if (process.platform === "win32" && fs.existsSync(file))
    fs.chmodSync(file, 0o600);
  fs.renameSync(temp, file);
}
function json(file, value) {
  write(file, JSON.stringify(value, null, 2) + "\n");
}
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  // Command arguments/output may contain database credentials; never echo them.
  assert(
    !result.error && result.status === 0,
    `${path.basename(command)} failed; check prerequisites and protected inputs`,
  );
  return result.stdout || "";
}
function openssl(args, options) {
  return run(process.env.OPENSSL || "openssl", args, options);
}
function random() {
  return crypto.randomBytes(32).toString("base64url");
}
function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function read(file) {
  return fs.readFileSync(file, "utf8");
}
function safeFile(root, relative) {
  assert(
    typeof relative === "string" &&
      relative.length > 0 &&
      !relative.includes("\\") &&
      !relative.includes("\0") &&
      !path.posix.isAbsolute(relative),
    "Invalid archive path",
  );
  assert(
    relative
      .split("/")
      .every(
        (x) =>
          x &&
          x !== "." &&
          x !== ".." &&
          !/[\x00-\x1f:]/.test(x) &&
          !/[. ]$/.test(x) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x),
      ),
    "Invalid archive path",
  );
  return path.join(root, ...relative.split("/"));
}
function files(root, prefix = "") {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    assert(
      !entry.isSymbolicLink(),
      "Symlinks are not permitted in deployment state",
    );
    const relative = prefix + entry.name;
    if (entry.name === ".lock") continue;
    if (entry.isDirectory())
      result.push(...files(path.join(root, entry.name), relative + "/"));
    else {
      assert(entry.isFile(), "Unsupported deployment file");
      result.push(relative);
    }
  }
  return result.sort();
}
function hostname(value) {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value.includes(".") &&
    value
      .split(".")
      .every((x) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))
  );
}
function privateIP(ip) {
  if (!net.isIPv4(ip)) return false;
  const a = ip.split(".").map(Number);
  return (
    a[0] === 10 ||
    a[0] === 127 ||
    (a[0] === 192 && a[1] === 168) ||
    (a[0] === 172 && a[1] >= 16 && a[1] <= 31)
  );
}
function validateConfig(c) {
  assert(
    c && /^[a-z][a-z0-9-]{0,40}$/.test(c.name),
    "Deployment name must be lowercase letters, digits and hyphens",
  );
  for (const field of [
    "apiHost",
    "mqttHost",
    "mqttServiceHost",
    "managementDomain",
  ])
    assert(hostname(c[field]), `Invalid ${field}`);
  assert(
    new Set([c.apiHost, c.mqttHost, c.mqttServiceHost]).size === 3,
    "API, reader MQTT and service MQTT hostnames must differ",
  );
  for (const field of ["readerBindAddress", "managementBindAddress"])
    assert(
      privateIP(c[field]),
      `${field} must be an explicit private IPv4 address`,
    );
  assert(
    Array.isArray(c.managementAllowedCidrs) &&
      c.managementAllowedCidrs.length > 0,
    "Management CIDRs are required",
  );
  for (const cidr of c.managementAllowedCidrs) {
    const parts = String(cidr).split("/");
    const [ip, bits] = parts;
    const minimumPrefix = ip.startsWith("192.168.")
      ? 16
      : ip.startsWith("172.")
        ? 12
        : 8;
    assert(
      parts.length === 2 &&
        privateIP(ip) &&
        /^\d+$/.test(bits || "") &&
        Number(bits) >= minimumPrefix &&
        Number(bits) <= 32,
      "Use explicit private management IPv4 CIDRs",
    );
  }
  for (const [field, value] of Object.entries({
    apiPort: 443,
    managementPort: 8443,
    mqttPort: 8883,
    mqttServicePort: 8884,
  })) {
    c[field] ??= value;
    assert(
      Number.isInteger(c[field]) && c[field] > 0 && c[field] <= 65535,
      `Invalid ${field}`,
    );
  }
  assert(
    new Set([c.apiPort, c.managementPort, c.mqttPort, c.mqttServicePort])
      .size === 4,
    "Published ports must be distinct",
  );
  assert(
    /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(c.dataSource || ""),
    "Invalid data source name",
  );
  assert(
    /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(c.database || "") &&
      !["admin", "config", "local"].includes(c.database),
    "Invalid application database",
  );
  const rails = new URL(c.railsUrl);
  assert(
    rails.protocol === "https:" &&
      !rails.username &&
      !rails.password &&
      rails.pathname === "/" &&
      !rails.search &&
      !rails.hash,
    "Rails URL must be an HTTPS origin without credentials or path",
  );
  assert(
    c.railsUrl === rails.origin || c.railsUrl === rails.origin + "/",
    "Rails URL must be a canonical origin",
  );
  c.railsUrl = rails.origin;
  return c;
}
function validateReader(r, c) {
  assert(
    r && /^[A-Za-z0-9_-]{1,48}$/.test(r.name || ""),
    "Invalid reader name",
  );
  assert(
    ["door", "garagedoor", "test", "latch", "tool"].includes(r.role),
    "Invalid reader role",
  );
  assert(
    r.role === "tool"
      ? /^[a-f0-9]{24}$/.test(r.toolId || "")
      : r.toolId === null,
    "Tool role requires a tool ObjectId; other roles require toolId=null",
  );
  assert(
    ["waveshare", "olimex", "qtpy"].includes(r.board),
    "Unsupported board",
  );
  assert(
    typeof r.production === "boolean",
    "Select production true or false explicitly",
  );
  assert(
    hostname(r.managementHost) &&
      r.managementHost.endsWith("." + c.managementDomain) &&
      r.managementHost.split(".").length ===
        c.managementDomain.split(".").length + 1,
    "Management hostname must be one label below managementDomain",
  );
  assert(
    privateIP(r.managementAddress),
    "Reader management address must be private IPv4",
  );
  assert(
    typeof r.where === "string" &&
      r.where.length <= 64 &&
      !/[\x00-\x1f]/.test(r.where),
    "Invalid reader location",
  );
  if (r.board === "qtpy" || r.wifiSsid || r.wifiPsk)
    assert(
      typeof r.wifiSsid === "string" &&
        Buffer.byteLength(r.wifiSsid) <= 32 &&
        r.wifiSsid.length &&
        typeof r.wifiPsk === "string" &&
        r.wifiPsk.length >= 8 &&
        r.wifiPsk.length <= 63,
      "Wi-Fi requires SSID and an 8-63 character passphrase",
    );
  if (r.cacheKeyHex !== undefined)
    assert(
      /^[a-fA-F0-9]{64}$/.test(r.cacheKeyHex),
      "Compiled cache key must be 64 hex digits",
    );
  return r;
}
function state(root) {
  const s = readJSON(path.join(root, "state.json"));
  assert(
    s.version === 1 && Array.isArray(s.readers),
    "Unsupported deployment state",
  );
  validateConfig(s.config);
  return s;
}
function twentyYears(date) {
  const end = new Date(date);
  end.setUTCFullYear(end.getUTCFullYear() + 20);
  // Calendar anniversary: Feb 29 in a non-leap century maps to Feb 28.
  if (end.getUTCMonth() !== date.getUTCMonth()) end.setUTCDate(0);
  return end;
}
function interval(now = new Date()) {
  const start = new Date(Math.floor(now.getTime() / 1000) * 1000);
  return { start: start.toISOString(), end: twentyYears(start).toISOString() };
}
function asnDate(date) {
  return (
    new Date(date)
      .toISOString()
      .replace(/[-:TZ]/g, "")
      .slice(0, 14) + "Z"
  );
}
module.exports = {
  fs,
  path,
  crypto,
  assert,
  mkdir,
  write,
  json,
  readJSON,
  read,
  run,
  openssl,
  random,
  sha,
  files,
  safeFile,
  hostname,
  privateIP,
  validateConfig,
  validateReader,
  state,
  twentyYears,
  interval,
  asnDate,
};
