// Runs inside deployment-tools on the disposable integration network.
const assert = require("node:assert/strict");
const mqtt = require("mqtt");
const c = require("../lib/core.cjs");
const { request, caBundle } = require("../lib/operations.cjs");
const { verify } = require("../lib/verify.cjs");
const s = c.state("/state"),
  r = s.readers[0],
  ca = caBundle("/state", s);
const reader = {
  ca,
  cert: c.read("/state/readers/" + r.id + "/cert.pem"),
  key: c.read("/state/readers/" + r.id + "/key.pem"),
};
function connect(port, auth) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect("mqtts://mqtt.fixture.test:" + port, {
      ...auth,
      ca,
      protocolVersion: 5,
      reconnectPeriod: 0,
      connectTimeout: 5000,
    });
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}
function publish(client, topic) {
  return new Promise((resolve) =>
    client.publish(topic, '{"fixture":true}', { qos: 1 }, (err, packet) =>
      resolve({ err, packet }),
    ),
  );
}
(async () => {
  await verify("/state", { reader: r.id });
  const clients = [];
  try {
    const device = await connect(8883, { ...reader, clientId: r.id });
    clients.push(device);
    const api = await connect(8884, {
      username: "api-sync",
      password: s.secrets.mqttApi,
    });
    clients.push(api);
    const rails = await connect(8884, {
      username: "rails",
      password: s.secrets.mqttRails,
    });
    clients.push(rails);
    assert.ok(!(await publish(device, "activity/checkins")).err);
    assert.ok(!(await publish(api, "readers/all/refresh")).err);
    assert.ok(!(await publish(rails, "reservations/fixture")).err);
    for (const [client, topic] of [
      [device, "readers/all/invalidate"],
      [api, "activity/checkins"],
      [rails, "readers/all/invalidate"],
    ]) {
      const result = await publish(client, topic);
      assert.ok(
        result.err || result.packet?.reasonCode >= 128,
        "Forbidden MQTT publication was acknowledged",
      );
    }
  } finally {
    for (const client of clients) client.end(true);
  }
  const api = "https://api.fixture.test:8443";
  const large = "x".repeat(17000);
  assert.equal(
    (
      await request(api + "/reader/v1/events", {
        ...reader,
        method: "POST",
        body: large,
        headers: { "Content-Length": Buffer.byteLength(large) },
      })
    ).status,
    413,
  );
  const mgmt = "https://tool.readers.fixture.test:9443";
  const upload = await request(mgmt + "/ota/upload", {
    ca,
    method: "POST",
    body: large,
    headers: {
      "Content-Length": large.length,
      Authorization:
        "Basic " +
        Buffer.from(r.webUsername + ":" + r.webPassword).toString("base64"),
      Referer: mgmt + "/update",
    },
  });
  assert.equal(upload.status, 200);
  assert.equal(JSON.parse(upload.body).bytes, 17000);
  assert.equal(JSON.parse(upload.body).referer, mgmt + "/update");
  console.log(
    "Disposable Compose checks passed: mTLS, API, MQTT ACLs, reservations and management upload forwarding",
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
