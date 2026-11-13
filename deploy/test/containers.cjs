// Explicit, destructive ONLY to this run's randomly named disposable containers.
const { spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const c = require("../lib/core.cjs"),
  ops = require("../lib/operations.cjs"),
  pki = require("../lib/pki.cjs");
const { render } = require("../lib/render.cjs");
const { fs, path } = c;
c.assert(
  process.env.RUN_DEPLOY_CONTAINER_TESTS === "1",
  "Set RUN_DEPLOY_CONTAINER_TESTS=1 for disposable Docker tests",
);
const root = path.resolve(__dirname, "../.."),
  id = "reader-ci-" + c.crypto.randomBytes(4).toString("hex");
const work = path.join(root, ".cache", id),
  state = path.join(work, "state");
c.mkdir(state);
const mongo = id + "-mongo",
  fixture = id + "-fixture",
  network = id + "-net";
const tools = "ts-data-api-deployment-tools:" + id;
function docker(args, capture = false) {
  const r = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  c.assert(!r.error && r.status === 0, "Disposable Docker command failed");
  return (r.stdout || "").trim();
}
function tool(args, entrypoint) {
  return docker([
    "run",
    "--rm",
    "--network",
    network,
    ...(process.getuid
      ? ["--user", `${process.getuid()}:${process.getgid()}`]
      : []),
    "--mount",
    `type=bind,source=${state},target=/state`,
    ...(entrypoint ? ["--entrypoint", entrypoint] : []),
    tools,
    ...args,
  ]);
}
let compose;
(async () => {
  docker(["build", "--target", "deployment-tools", "-t", tools, "."]);
  docker(["network", "create", network]);
  docker([
    "run",
    "-d",
    "--name",
    mongo,
    "--network",
    network,
    "--network-alias",
    "mongodb",
    "mongo:8.0.38@sha256:d97fea17ccb8d004cd137be8dab54d70d0df11be69c9f422aefe4484c8414ab7",
    "--replSet",
    "rs0",
    "--bind_ip_all",
  ]);
  docker([
    "run",
    "-d",
    "--name",
    fixture,
    "--network",
    network,
    "--network-alias",
    "rails.fixture.test",
    "--mount",
    `type=bind,source=${state},target=/state`,
    "--entrypoint",
    "sleep",
    tools,
    "infinity",
  ]);
  const fixtureIP = docker(
    [
      "inspect",
      "-f",
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
      fixture,
    ],
    true,
  );
  const config = {
    ...require("../deployment.example.json"),
    name: id,
    apiHost: "api.fixture.test",
    mqttHost: "mqtt.fixture.test",
    mqttServiceHost: "service-mqtt.fixture.test",
    managementDomain: "readers.fixture.test",
    apiPort: 8443,
    managementPort: 9443,
    readerBindAddress: "127.0.0.1",
    managementBindAddress: "127.0.0.1",
    managementAllowedCidrs: [
      "172.16.0.0/12",
      "192.168.0.0/16",
      "10.0.0.0/8",
      "127.0.0.0/8",
    ],
    database: "fixture",
    railsUrl: "https://rails.fixture.test:9444",
  };
  c.json(path.join(work, "config.json"), config);
  c.write(path.join(work, "uri"), "mongodb://mongodb:27017/?replicaSet=rs0");
  ops.init(state, {
    config: path.join(work, "config.json"),
    mongoUriFile: path.join(work, "uri"),
  });
  c.json(path.join(work, "reader.json"), {
    ...require("../reader.example.json"),
    name: "tool",
    role: "tool",
    toolId: "111111111111111111111111",
    managementHost: "tool.readers.fixture.test",
    managementAddress: fixtureIP,
  });
  ops.addReader(state, { readerFile: path.join(work, "reader.json") });
  const s = c.state(state);
  pki.issue(
    state,
    s.serverCA,
    "certificates/rails",
    "rails.fixture.test",
    "server",
    s.serverValidity,
    ["rails.fixture.test"],
  );
  // Replica set initialization retries only connection startup, then awaits primary.
  tool(
    [
      "-e",
      `const {MongoClient,ObjectId}=require('mongodb');(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));let c;for(let n=0;n<30;n++){try{c=await MongoClient.connect('mongodb://mongodb:27017/?directConnection=true',{serverSelectionTimeoutMS:1000});break;}catch{await sleep(1000);}}if(!c)throw Error('Mongo startup timeout');await c.db('admin').command({replSetInitiate:{_id:'rs0',members:[{_id:0,host:'mongodb:27017'}]}});for(let n=0;n<30;n++){if((await c.db('admin').command({hello:1})).isWritablePrimary)break;await sleep(1000);}const db=c.db('fixture');await db.collection('cards').createIndex({uid:1},{unique:true});await db.collection('shops').insertOne({_id:new ObjectId('222222222222222222222222'),name:'fixture',reservable:true});await db.collection('tools').insertOne({_id:new ObjectId('111111111111111111111111'),shop_id:new ObjectId('222222222222222222222222'),name:'fixture',reservable:true});await c.close();})().catch(e=>{console.error(e.message);process.exitCode=1;});`,
    ],
    "node",
  );
  tool(["indexes"]);
  tool(["register-readers"]);
  docker(["exec", "-d", fixture, "node", "deploy/test/fixture.cjs"]);
  const override = {
    services: {
      api: { networks: { integration: {} } },
      haproxy: {
        networks: {
          integration: {
            aliases: ["api.fixture.test", "tool.readers.fixture.test"],
          },
        },
      },
      mosquitto: {
        networks: {
          integration: {
            aliases: ["mqtt.fixture.test", "service-mqtt.fixture.test"],
          },
        },
      },
    },
    networks: { integration: { external: true, name: network } },
  };
  c.json(path.join(work, "override.json"), override);
  process.env.DEPLOY_STATE = state.replace(/\\/g, "/");
  compose = [
    "compose",
    "--env-file",
    path.join(state, "compose.env"),
    "-f",
    "docker-compose.yaml",
    "-f",
    path.join(work, "override.json"),
  ];
  docker([...compose, "config", "--quiet"]);
  docker([
    ...compose,
    "run",
    "--rm",
    "--no-deps",
    "haproxy",
    "haproxy",
    "-c",
    "-f",
    "/usr/local/etc/haproxy/haproxy.cfg",
  ]);
  docker([
    ...compose,
    "up",
    "-d",
    "--build",
    "--wait",
    "--wait-timeout",
    "180",
  ]);
  await delay(1000);
  tool(["preflight"]);
  tool(["deploy/test/container-checks.cjs"], "node");
  tool(["revoke-reader", "--reader", s.readers[0].id]);
  docker([...compose, "up", "-d", "--force-recreate", "haproxy", "mosquitto"]);
  await delay(2000);
  tool(
    [
      "-e",
      `const {request,caBundle}=require('./deploy/lib/operations.cjs');const c=require('./deploy/lib/core.cjs');const s=c.state('/state'),r=s.readers[0];request('https://api.fixture.test:8443/reader/v1/config',{ca:caBundle('/state',s),cert:c.read('/state/readers/'+r.id+'/cert.pem'),key:c.read('/state/readers/'+r.id+'/key.pem')}).then(()=>{throw Error('Revoked certificate accepted');}).catch(e=>{if(e.message==='Revoked certificate accepted'){console.error(e.message);process.exitCode=1;}else console.log('Revoked TLS certificate rejected');});`,
    ],
    "node",
  );
})()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (compose)
      spawnSync(
        "docker",
        [...compose, "down", "--volumes", "--remove-orphans"],
        { cwd: root, stdio: "inherit" },
      );
    spawnSync("docker", ["rm", "-f", mongo, fixture], { stdio: "inherit" });
    spawnSync("docker", ["network", "rm", network], { stdio: "inherit" });
    // Leave test-only state in ignored .cache for failure diagnosis; never upload it.
  });
