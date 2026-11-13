#!/usr/bin/env node
const { fs, path, assert, mkdir, state, json } = require("./lib/core.cjs");
const ops = require("./lib/operations.cjs");
const { render } = require("./lib/render.cjs");
const recovery = require("./lib/recovery.cjs");
const pki = require("./lib/pki.cjs");
const booleanOptions = new Set([
  "offline",
  "before-indexes",
  "writers-paused",
  "skip-management",
]);
const valueOptions = new Set([
  "state",
  "config",
  "mongo-uri-file",
  "card-key-file",
  "rails-secret-file",
  "additional-ca-file",
  "reader-file",
  "reader",
  "output",
  "input",
  "mode",
  "recipient",
  "identity",
  "database-archive",
  "snapshot",
]);
function parse(args) {
  const command = args.shift() || "help",
    o = {};
  while (args.length) {
    const flag = args.shift();
    assert(flag.startsWith("--"), "Options require --name");
    const name = flag.slice(2);
    assert(
      booleanOptions.has(name) || valueOptions.has(name),
      "Unknown option",
    );
    const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    assert(o[key] === undefined, "Duplicate option");
    o[key] = booleanOptions.has(name) ? true : args.shift();
    assert(
      o[key] !== undefined &&
        !(typeof o[key] === "string" && o[key].startsWith("--")),
      "Missing option value",
    );
  }
  return { command, o };
}
async function main(args) {
  const { command, o } = parse(args);
  if (command === "help") {
    console.log(`Reader deployment tools (all generated certificates: 20 calendar years)
init --config FILE --mongo-uri-file FILE [--card-key-file FILE] [--rails-secret-file FILE] [--additional-ca-file FILE]
preflight [--offline] [--before-indexes]
indexes
add-reader --reader-file FILE
register-readers
render
revoke-reader --reader NAME_OR_ID
export --output FILE.tar.age [--recipient AGE_RECIPIENT] [--database-archive FILE | --snapshot REFERENCE]
restore --input FILE.tar.age --mode rebuild|isolated-test [--identity FILE] [--config FILE --mongo-uri-file FILE]
backup-db --output FILE.archive --writers-paused
restore-db
verify --reader NAME_OR_ID [--skip-management]
All commands accept --state DIRECTORY (default /state).
Container paths: /input for supplied files, /transfer for backups, /state for persistent state.
No command initializes physical cards, erases readers, or programs eFuses.`);
    return;
  }
  const root = path.resolve(o.state || "/state");
  mkdir(root);
  const lock = path.join(root, ".lock");
  let fd;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch {
    throw Error(
      "Deployment is locked; check for a running operation before removing a stale .lock",
    );
  }
  try {
    if (!["init", "restore"].includes(command))
      assert(
        !fs.existsSync(path.join(root, ".incomplete-add-reader")),
        "Incomplete reader generation exists; recover the deployment archive before continuing",
      );
    switch (command) {
      case "init":
        ops.init(root, o);
        break;
      case "add-reader":
        console.log("Prepared reader " + ops.addReader(root, o));
        break;
      case "preflight":
        await ops.preflight(root, o);
        break;
      case "indexes":
        await ops.indexes(root);
        break;
      case "register-readers":
        await ops.registerReaders(root);
        break;
      case "render": {
        const s = state(root);
        ops.validateSourceState(root, s);
        for (const ca of [{ name: s.serverCA }, ...s.readerCAs])
          pki.refreshConfig(path.join(root, "pki", ca.name));
        render(root, s);
        break;
      }
      case "revoke-reader":
        await ops.revokeReader(root, o);
        console.log(
          "Recreate HAProxy and Mosquitto to apply CRLs/ACLs and disconnect existing sessions.",
        );
        break;
      case "export":
        await recovery.exportState(root, o);
        break;
      case "restore":
        await recovery.restoreState(root, o);
        console.log(
          "Restore validated. Run render before starting containers.",
        );
        break;
      case "backup-db":
        await ops.backupDB(root, o);
        break;
      case "restore-db":
        await ops.restoreDB(root, o);
        break;
      case "verify":
        await require("./lib/verify.cjs").verify(root, o);
        break;
      default:
        throw Error("Unknown operation; run help");
    }
    console.log(`${command} completed. Secret values are not printed.`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    const message =
      error.name === "SyntaxError"
        ? "Invalid JSON input; inspect the protected file"
        : error.message;
    // Driver exceptions may carry connection details. Deliberately hide them.
    console.error(
      error.name?.startsWith("Mongo")
        ? "MongoDB operation failed; check access, indexes and connectivity"
        : message,
    );
    process.exitCode = 1;
  });
module.exports = { main, parse };
