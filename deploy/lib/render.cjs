const {
  fs,
  path,
  write,
  read,
  json,
  crypto,
  assert,
  validateReader,
} = require("./core.cjs");

function passwordHash(password) {
  const salt = crypto.randomBytes(12),
    rounds = 210000;
  return `$7$${rounds}$${salt.toString("base64")}$${crypto.pbkdf2Sync(password, salt, rounds, 64, "sha512").toString("base64")}`;
}
const activity = [
  "activity/checkins",
  "activity/checkins/+/+",
  "activity/checkends/+/+",
];
const hints = [
  "cards/#",
  "tools/#",
  "shops/#",
  "readers/all/invalidate",
  "readers/all/refresh",
  "readers/all/reservations/refresh",
  "reservations/#",
];
const publications = [
  "tools/+",
  "shops/+",
  "readers/all/invalidate",
  "readers/all/refresh",
  "readers/all/reservations/refresh",
];
function firmware(root, s, r) {
  validateReader(r, s.config);
  const dir = path.join(root, "readers", r.id),
    c = s.config;
  const str = (v) => JSON.stringify(v).replace(/\\u2028/g, "\\u2028");
  const pem = (name, value) =>
    `#define ${name} R"READERPEM(${value.trim()}\n)READERPEM"\n`;
  let out =
    "#pragma once\n// GENERATED PRIVATE CONFIGURATION. Preserve for rebuilds; never commit.\n";
  for (const [name, value] of Object.entries({
    WEB_USERNAME: r.webUsername,
    WEB_PASSWORD: r.webPassword,
    API_URL: `https://${c.apiHost}${c.apiPort === 443 ? "" : ":" + c.apiPort}`,
    MQTT_URL: `mqtts://${c.mqttHost}:${c.mqttPort}`,
    DEVICE_ID: r.id,
  }))
    out += `#define ${name} ${str(value)}\n`;
  out += pem(
    "SERVER_CA",
    read(path.join(root, "pki", s.serverCA, "cert.pem")) +
      (s.additionalServerCA
        ? read(path.join(root, "additional-server-ca.pem"))
        : ""),
  );
  out +=
    pem("CLIENT_CERT", read(path.join(dir, "cert.pem"))) +
    pem("CLIENT_KEY", read(path.join(dir, "key.pem")));
  out += `#define READER_PRODUCTION ${r.production ? 1 : 0}\n#define READER_FORMAT_NEW_FS 1\n`;
  out +=
    "// Build with scripts/build.ps1 -Reservations 1 (global translation-unit flag).\n";
  if (r.cacheKeyHex) out += `#define CACHE_KEY_HEX ${str(r.cacheKeyHex)}\n`;
  else
    out +=
      "// CACHE_KEY_HEX intentionally undefined: preserve reader NVS and LittleFS.\n";
  if (r.wifiSsid)
    out += `#define WIFI_SSID ${str(r.wifiSsid)}\n#define WIFI_PSK ${str(r.wifiPsk)}\n`;
  write(path.join(dir, "secrets.h"), out);
}
function render(root, s) {
  const c = s.config,
    runtime = path.join(root, "runtime");
  const put = (file, value) => write(path.join(runtime, file), value, 0o444);
  const serverCA = read(path.join(root, "pki", s.serverCA, "cert.pem"));
  put(
    "server-ca.pem",
    serverCA +
      (s.additionalServerCA
        ? read(path.join(root, "additional-server-ca.pem"))
        : ""),
  );
  put(
    "reader-ca.pem",
    s.readerCAs
      .map((ca) => read(path.join(root, "pki", ca.name, "cert.pem")))
      .join("\n"),
  );
  put(
    "reader-crl.pem",
    s.readerCAs
      .map((ca) => read(path.join(root, "pki", ca.name, "crl.pem")))
      .join("\n"),
  );
  put(
    "api-server.pem",
    read(path.join(root, "certificates/api/cert.pem")) +
      read(path.join(root, "certificates/api/key.pem")),
  );
  put("broker.crt", read(path.join(root, "certificates/broker/cert.pem")));
  put("broker.key", read(path.join(root, "certificates/broker/key.pem")));
  for (const [name, value] of Object.entries({
    "data-sources": JSON.stringify({ [c.dataSource]: s.secrets.mongoUri }),
    jwt: s.secrets.jwt,
    proxy: s.secrets.proxy,
    "card-key": s.secrets.cardKey,
    "mqtt-api": s.secrets.mqttApi,
    reservations: s.secrets.reservations,
  }))
    put("secrets/" + name, value + "\n");
  put(
    "mqtt-passwords",
    `api-sync:${s.secrets.mqttApiHash}\nrails:${s.secrets.mqttRailsHash}\n`,
  );
  put(
    "api.env",
    `READER_DATA_SOURCE=${c.dataSource}\nREADER_DATABASE=${c.database}\nREADER_MQTT_URL=mqtts://mosquitto:8884\nREADER_MQTT_USERNAME=api-sync\nREADER_RAILS_URL=${c.railsUrl}\n`,
  );
  write(
    path.join(root, "compose.env"),
    `COMPOSE_PROJECT_NAME=${c.name}\nREADER_BIND_ADDRESS=${c.readerBindAddress}\nMANAGEMENT_BIND_ADDRESS=${c.managementBindAddress}\nAPI_PORT=${c.apiPort}\nMANAGEMENT_PORT=${c.managementPort}\nMQTT_PORT=${c.mqttPort}\nMQTT_SERVICE_PORT=${c.mqttServicePort}\nDEPLOY_REVISION=${s.sourceRevision}\n`,
  );
  const active = s.readers.filter((r) => !r.revoked);
  put(
    "readers.acl",
    active
      .map(
        (r) =>
          `user ${r.id}\n` +
          hints.map((t) => "topic read " + t).join("\n") +
          "\n" +
          activity.map((t) => "topic write " + t).join("\n"),
      )
      .join("\n\n") + "\n",
  );
  put(
    "services.acl",
    "user api-sync\n" +
      publications.map((t) => "topic write " + t).join("\n") +
      "\n\nuser rails\ntopic write reservations/#\n" +
      activity.map((t) => "topic read " + t).join("\n") +
      "\n",
  );
  put(
    "mosquitto.conf",
    `per_listener_settings true\npersistence true\npersistence_location /mosquitto/data/\nlog_dest stdout\nlog_type error\nlog_type warning\nlog_type notice\nmax_packet_size 524288\nmax_queued_messages 1000\nlistener 8883\nprotocol mqtt\nallow_anonymous false\ncafile /run/secrets/reader-ca.pem\ncertfile /run/secrets/broker.crt\nkeyfile /run/secrets/broker.key\ncrlfile /run/secrets/reader-crl.pem\ntls_version tlsv1.2\nrequire_certificate true\nuse_identity_as_username true\nuse_username_as_clientid true\nacl_file /mosquitto/config/readers.acl\nlistener 8884\nprotocol mqtt\nallow_anonymous false\ncertfile /run/secrets/broker.crt\nkeyfile /run/secrets/broker.key\ntls_version tlsv1.2\nrequire_certificate false\npassword_file /run/secrets/mqtt-passwords\nacl_file /mosquitto/config/services.acl\n`,
  );
  let haproxy = `global
    log stdout format raw local0
    maxconn 256
defaults
    log global
    mode http
    timeout connect 5s
    timeout client 15s
    timeout server 15s
resolvers docker
    nameserver dns 127.0.0.11:53
    resolve_retries 3
    timeout resolve 1s
    timeout retry 1s
    hold valid 10s
frontend health
    bind 127.0.0.1:8404
    http-request return status 200 content-type text/plain string healthy
frontend readers
    bind :8443 ssl crt /run/secrets/api-server.pem ca-file /run/secrets/reader-ca.pem crl-file /run/secrets/reader-crl.pem verify required ssl-min-ver TLSv1.2
    http-request deny deny_status 404 unless { path_beg /reader/v1/ }
    http-request deny deny_status 413 if { req.hdr_val(content-length) gt 16384 }
    http-request deny deny_status 411 if { req.hdr(transfer-encoding) -m found }
    http-request deny deny_status 411 if METH_POST !{ req.hdr(content-length) -m found }
    http-request del-header x-reader-certificate
    http-request del-header x-reader-proxy-secret
    http-request set-header x-reader-certificate %[ssl_c_der,sha2(256),hex,lower]
    http-request set-header x-reader-proxy-secret "\${READER_PROXY_SECRET}"
    default_backend reader_api
backend reader_api
    server api api:8080 check resolvers docker init-addr libc,none
frontend management
    bind :9443 ssl crt /run/secrets/api-server.pem ssl-min-ver TLSv1.2
    timeout client 5m
    acl management_network src ${c.managementAllowedCidrs.join(" ")}
    http-request deny deny_status 403 unless management_network
    http-request deny deny_status 413 if { req.hdr_val(content-length) gt 5242880 }
    http-request deny deny_status 411 if { req.hdr(transfer-encoding) -m found }
    http-request deny deny_status 411 if METH_POST !{ req.hdr(content-length) -m found }
`;
  for (const r of active)
    haproxy += `    use_backend management_${r.id} if { req.hdr(host),lower,field(1,:) -m str ${r.managementHost} }\n`;
  haproxy +=
    "    default_backend unknown_management\nbackend unknown_management\n    http-request deny deny_status 404\n";
  for (const r of active)
    haproxy += `backend management_${r.id}\n    timeout server 5m\n    server reader ${r.managementAddress}:80 check\n`;
  put("haproxy.cfg", haproxy);
  for (const r of s.readers) firmware(root, s, r);
  json(path.join(root, "rails-handoff.json"), {
    reservationServiceSecret: s.secrets.reservations,
    mqttUrl: `mqtts://${c.mqttServiceHost}:${c.mqttServicePort}`,
    mqttUsername: "rails",
    mqttPassword: s.secrets.mqttRails,
    caFile: "runtime/server-ca.pem",
    requiredEndpoint: "/api/internal/reader_reservations/sync",
  });
  json(
    path.join(root, "registrations.json"),
    s.readers.map((r) => ({
      _id: { $oid: r.id },
      name: r.name,
      certificateFingerprint: r.certificateFingerprint,
      enabled: !r.revoked,
      role: r.role,
      toolId: r.toolId ? { $oid: r.toolId } : null,
      where: r.where,
      enrollmentEnabled: false,
    })),
  );
}
module.exports = {
  render,
  firmware,
  passwordHash,
  activity,
  hints,
  publications,
};
