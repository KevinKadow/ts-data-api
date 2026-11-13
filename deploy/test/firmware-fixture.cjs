// Generate test-only headers for CI or an isolated firmware checkout.
const c = require("../lib/core.cjs");
const ops = require("../lib/operations.cjs");
const board = process.argv[2],
  output = process.argv[3];
c.assert(
  ["waveshare", "olimex", "qtpy"].includes(board) && output,
  "Usage: firmware-fixture.cjs BOARD OUTPUT_HEADER",
);
const root = c.path.resolve(".cache", "firmware-credentials-" + board);
c.mkdir(root);
const input = c.path.resolve(".cache", "firmware-input-" + board);
c.mkdir(input);
c.json(
  c.path.join(input, "config.json"),
  require("../deployment.example.json"),
);
c.write(c.path.join(input, "uri"), "mongodb://127.0.0.1:27017/fixture");
ops.init(root, {
  config: c.path.join(input, "config.json"),
  mongoUriFile: c.path.join(input, "uri"),
});
c.json(c.path.join(input, "reader.json"), {
  ...require("../reader.example.json"),
  name: board,
  board,
  managementHost: board + ".readers.example.org",
  wifiSsid: "unused-fixture-network",
  wifiPsk: "unused-fixture-password",
});
const id = ops.addReader(root, {
  readerFile: c.path.join(input, "reader.json"),
});
c.fs.copyFileSync(c.path.join(root, "readers", id, "secrets.h"), output);
console.log(
  "Generated test-only firmware header for " +
    board +
    "; no hardware is contacted.",
);
