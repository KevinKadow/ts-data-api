const mqtt = require("mqtt");
const { path, read, state, assert } = require("./core.cjs");
const { validateState, request, caBundle } = require("./operations.cjs");
function mqttConnect(url, options) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, {
      ...options,
      reconnectPeriod: 0,
      connectTimeout: 8000,
      rejectUnauthorized: true,
      clean: true,
    });
    const timer = setTimeout(() => {
      client.end(true);
      reject(Error("MQTT connection timed out"));
    }, 10000);
    client.once("connect", () => {
      clearTimeout(timer);
      client.end(false, {}, () => resolve());
    });
    client.once("error", () => {
      clearTimeout(timer);
      client.end(true);
      reject(Error("MQTT TLS/authentication failed"));
    });
  });
}
async function verify(root, o) {
  const s = state(root);
  validateState(root, s);
  const r = s.readers.find((x) => x.id === o.reader || x.name === o.reader);
  assert(r && !r.revoked, "Select an active registered bench reader");
  const c = s.config,
    ca = caBundle(root, s),
    cert = read(path.join(root, "readers", r.id, "cert.pem")),
    key = read(path.join(root, "readers", r.id, "key.pem"));
  const origin = `https://${c.apiHost}:${c.apiPort}`;
  let denied = false;
  try {
    await request(origin + "/reader/v1/config", { ca });
  } catch {
    denied = true;
  }
  assert(denied, "Gateway accepted a request without a client certificate");
  const config = await request(origin + "/reader/v1/config", {
    ca,
    cert,
    key,
    headers: {
      "x-reader-certificate": "0".repeat(64),
      "x-reader-proxy-secret": "spoofed",
    },
  });
  assert(
    config.status === 200 && JSON.parse(config.body).id === r.id,
    "Reader identity or trusted-header replacement failed",
  );
  assert(
    (await request(origin + "/defaults/find", { ca, cert, key })).status ===
      404,
    "Legacy routes are exposed by the reader gateway",
  );
  await mqttConnect(`mqtts://${c.mqttHost}:${c.mqttPort}`, {
    ca,
    cert,
    key,
    clientId: r.id,
  });
  await mqttConnect(`mqtts://${c.mqttServiceHost}:${c.mqttServicePort}`, {
    ca,
    username: "api-sync",
    password: s.secrets.mqttApi,
  });
  await mqttConnect(`mqtts://${c.mqttServiceHost}:${c.mqttServicePort}`, {
    ca,
    username: "rails",
    password: s.secrets.mqttRails,
  });
  if (!o.skipManagement) {
    const management = `https://${r.managementHost}:${c.managementPort}/api/local/stats`;
    assert(
      (await request(management, { ca })).status === 401,
      "Reader management did not require login",
    );
    assert(
      (
        await request(management, {
          ca,
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(r.webUsername + ":" + r.webPassword).toString(
                "base64",
              ),
          },
        })
      ).status === 200,
      "Management routing/login failed",
    );
  }
  if (r.role === "tool") {
    assert(
      (await request(origin + "/reader/v1/reservations", { ca, cert, key }))
        .status === 200,
      "Reservation read failed",
    );
    const body = JSON.stringify({ capable: true, operations: [] });
    const sync = await request(origin + "/reader/v1/reservations/sync", {
      ca,
      cert,
      key,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      body,
    });
    assert(
      sync.status === 200 && Array.isArray(JSON.parse(sync.body).results),
      "Rails reservation endpoint or shared secret is unavailable",
    );
  } else
    console.log(
      "Reservation synchronization requires a Tool reader; rerun verify with a configured Tool reader before commissioning reservations.",
    );
  console.log(
    "Verified mTLS identity, header replacement, route isolation, MQTT logins and requested management/reservation checks.",
  );
}
module.exports = { verify, mqttConnect };
