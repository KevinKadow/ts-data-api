const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const {
  fs,
  path,
  crypto,
  sha,
  assert,
  mkdir,
  json,
  readJSON,
  files,
  safeFile,
  state,
  validateConfig,
} = require("./core.cjs");

async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function header(name, size) {
  assert(
    Buffer.byteLength(name) < 100 && size < 0o77777777777,
    "Archive member exceeds USTAR limits",
  );
  const h = Buffer.alloc(512);
  h.write(name);
  h.write("0000600\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.fill(32, 148, 156);
  h[156] = 48;
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(
    [...h]
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
  );
  return h;
}
async function* pack(root, manifest, extra) {
  const meta = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  yield header("recovery-manifest.json", meta.length);
  yield meta;
  yield Buffer.alloc((512 - (meta.length % 512)) % 512);
  for (const item of manifest.files) {
    const file =
      item.path === "backup/database.archive" && extra
        ? extra
        : safeFile(root, item.path);
    yield header(item.path, item.size);
    const hash = crypto.createHash("sha256");
    let size = 0;
    for await (const chunk of fs.createReadStream(file)) {
      hash.update(chunk);
      size += chunk.length;
      yield chunk;
    }
    assert(
      size === item.size && hash.digest("hex") === item.sha256,
      "State changed during export; archive discarded",
    );
    yield Buffer.alloc((512 - (size % 512)) % 512);
  }
  yield Buffer.alloc(1024);
}
async function exportState(root, options) {
  const s = state(root);
  require("./operations.cjs").validateState(root, s);
  const output = path.resolve(options.output || "");
  assert(
    options.output && output.endsWith(".tar.age") && !fs.existsSync(output),
    "Choose a new .tar.age export path",
  );
  assert(
    !output.startsWith(path.resolve(root) + path.sep),
    "Export outside deployment state",
  );
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    deploymentId: s.deploymentId,
    images: s.images,
    sourceRevision: s.sourceRevision,
    databaseSnapshot: options.snapshot || null,
    files: [],
  };
  assert(
    !(options.databaseArchive && options.snapshot),
    "Choose a database archive or an external snapshot reference, not both",
  );
  for (const relative of files(root)) {
    // A restored database dump is historical. Require an explicit new backup
    // instead of silently exporting it as the current database state.
    if (relative.startsWith("backup/")) continue;
    assert(
      !relative.split("/").some((x) => x.startsWith(".")),
      "Unfinished operation in state; resolve before export",
    );
    const file = safeFile(root, relative);
    manifest.files.push({
      path: relative,
      size: fs.statSync(file).size,
      sha256: await hashFile(file),
    });
  }
  if (options.databaseArchive) {
    const metadata = readJSON(options.databaseArchive + ".json");
    assert(
      metadata.version === 1 &&
        metadata.consistency === "writers-paused" &&
        metadata.deploymentId === s.deploymentId &&
        metadata.database === s.config.database &&
        metadata.cardKeyFingerprint ===
          sha(Buffer.from(s.secrets.cardKey, "base64")),
      "Database archive is missing matching consistency metadata",
    );
    const digest = await hashFile(options.databaseArchive);
    assert(digest === metadata.sha256, "Database backup hash mismatch");
    manifest.databaseSnapshot = metadata;
    assert(
      !manifest.files.some((x) => x.path.startsWith("backup/")),
      "State already contains a database backup",
    );
    manifest.files.push({
      path: "backup/database.archive",
      size: fs.statSync(options.databaseArchive).size,
      sha256: digest,
    });
  }
  const partial = output + ".partial";
  assert(!fs.existsSync(partial), "Partial export already exists");
  const args = options.recipient ? ["-r", options.recipient] : ["-p"];
  args.push("-o", partial);
  const child = spawn(process.env.AGE || "age", args, {
    stdio: ["pipe", "ignore", "inherit"],
    windowsHide: true,
  });
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(Error("age encryption failed")),
    );
  });
  // Attach immediately so an early child failure cannot become unhandled.
  completed.catch(() => {});
  try {
    await pipeline(
      Readable.from(pack(root, manifest, options.databaseArchive)),
      child.stdin,
    );
    await completed;
    fs.chmodSync(partial, 0o600);
    fs.renameSync(partial, output);
  } catch (error) {
    child.kill();
    await completed.catch(() => {});
    fs.rmSync(partial, { force: true });
    throw error;
  }
  return manifest;
}
async function unpack(stream, root) {
  let buffer = Buffer.alloc(0),
    current = null,
    padding = 0,
    zeros = 0;
  const seen = new Set();
  let manifest = null;
  try {
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (current) {
          const n = Math.min(buffer.length, current.remaining);
          if (n) {
            let written = 0;
            while (written < n)
              written += fs.writeSync(current.fd, buffer.subarray(written, n));
            current.hash.update(buffer.subarray(0, n));
            current.remaining -= n;
            buffer = buffer.subarray(n);
          }
          if (current.remaining) break;
          fs.closeSync(current.fd);
          current.fd = null;
          if (current.name === "recovery-manifest.json") {
            manifest = readJSON(current.file);
            assert(
              manifest.version === 1 &&
                Array.isArray(manifest.files) &&
                manifest.files.length <= 100000,
              "Invalid recovery manifest",
            );
            const paths = new Set();
            for (const item of manifest.files) {
              safeFile(root, item.path);
              assert(
                !paths.has(item.path) &&
                  item.path !== "recovery-manifest.json" &&
                  Number.isSafeInteger(item.size) &&
                  item.size >= 0 &&
                  /^[a-f0-9]{64}$/.test(item.sha256),
                "Invalid manifest member",
              );
              paths.add(item.path);
            }
          } else {
            const expected = manifest.files.find(
              (x) => x.path === current.name,
            );
            assert(
              expected &&
                expected.size === current.size &&
                expected.sha256 === current.hash.digest("hex"),
              "Recovery member hash mismatch",
            );
          }
          padding = (512 - (current.size % 512)) % 512;
          current = null;
        }
        if (padding) {
          const n = Math.min(padding, buffer.length);
          assert(
            buffer.subarray(0, n).every((x) => x === 0),
            "Invalid tar padding",
          );
          buffer = buffer.subarray(n);
          padding -= n;
          if (padding) break;
        }
        if (buffer.length < 512) break;
        const h = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (h.every((x) => x === 0)) {
          zeros++;
          continue;
        }
        assert(!zeros, "Unexpected data after archive terminator");
        const text = (offset, length) =>
          h
            .subarray(offset, offset + length)
            .toString("utf8")
            .replace(/\0.*$/s, "");
        const name = text(0, 100),
          sizeText = text(124, 12).trim(),
          sumText = text(148, 8).trim();
        assert(
          /^[0-7]+$/.test(sizeText) && /^[0-7]+$/.test(sumText),
          "Invalid tar numbers",
        );
        const sum = [...h].reduce(
          (a, b, i) => a + (i >= 148 && i < 156 ? 32 : b),
          0,
        );
        assert(
          sum === parseInt(sumText, 8) &&
            h[156] === 48 &&
            text(257, 6) === "ustar" &&
            !text(345, 155),
          "Only regular USTAR members are allowed",
        );
        assert(
          !seen.has(name) && seen.size < 100001,
          "Duplicate or excessive archive members",
        );
        seen.add(name);
        if (!manifest)
          assert(
            name === "recovery-manifest.json",
            "Recovery manifest must be first",
          );
        else
          assert(
            manifest.files.some((x) => x.path === name),
            "Unlisted recovery member",
          );
        const size = parseInt(sizeText, 8);
        assert(
          Number.isSafeInteger(size) &&
            size <= 0o77777777777 &&
            (name !== "recovery-manifest.json" || size <= 16 * 1024 * 1024),
          "Oversized recovery member",
        );
        const file = safeFile(root, name);
        mkdir(path.dirname(file));
        current = {
          name,
          file,
          size,
          remaining: size,
          hash: crypto.createHash("sha256"),
          fd: fs.openSync(file, "wx", 0o600),
        };
      }
    }
    assert(
      !current &&
        !padding &&
        buffer.every((x) => x === 0) &&
        zeros >= 2 &&
        manifest,
      "Truncated recovery archive",
    );
    assert(
      manifest.files.every((x) => seen.has(x.path)),
      "Missing recovery members",
    );
    return manifest;
  } finally {
    if (current?.fd !== null && current?.fd !== undefined)
      fs.closeSync(current.fd);
  }
}
function isolated(s, config, uri) {
  validateConfig(config);
  assert(
    config.name !== s.config.name,
    "Test deployment requires a distinct Compose project name",
  );
  // Keep compiled hostnames/certificates. Route them through isolated DNS.
  for (const key of [
    "apiHost",
    "mqttHost",
    "mqttServiceHost",
    "managementDomain",
    "apiPort",
    "mqttPort",
  ])
    assert(
      config[key] === s.config[key],
      "Isolated test must preserve compiled endpoint names and ports",
    );
  assert(
    config.database !== s.config.database,
    "Test database name must differ from source, even on another cluster",
  );
  assert(
    config.railsUrl !== s.config.railsUrl,
    "Test Rails URL must differ from production",
  );
  assert(
    config.readerBindAddress !== s.config.readerBindAddress &&
      config.managementBindAddress !== s.config.managementBindAddress,
    "Test network addresses must differ from production",
  );
  assert(
    config.managementAllowedCidrs.every(
      (x) => !s.config.managementAllowedCidrs.includes(x),
    ),
    "Use distinct test management networks",
  );
  assert(/^mongodb(?:\+srv)?:\/\//.test(uri), "A test MongoDB URI is required");
  s.restoredFrom = {
    config: s.config,
    deploymentId: s.deploymentId,
    mode: "isolated-test",
  };
  s.config = config;
  s.secrets.mongoUri = uri;
  s.databaseBinding = null;
  return s;
}
async function restoreState(root, options) {
  assert(
    ["rebuild", "isolated-test"].includes(options.mode),
    "Select restore mode rebuild or isolated-test",
  );
  assert(
    fs.readdirSync(root).every((x) => x === ".lock"),
    "Restore requires an empty state directory",
  );
  const stage = path.join(root, ".restore-stage");
  mkdir(stage);
  const args = ["-d"];
  if (options.identity) args.push("-i", options.identity);
  args.push(options.input);
  const child = spawn(process.env.AGE || "age", args, {
    stdio: ["inherit", "pipe", "inherit"],
    windowsHide: true,
  });
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(Error("age decryption failed")),
    );
  });
  completed.catch(() => {});
  try {
    const manifest = await unpack(child.stdout, stage);
    await completed;
    let s = state(stage);
    assert(
      s.deploymentId === manifest.deploymentId,
      "Recovery deployment identity mismatch",
    );
    require("./operations.cjs").validateState(stage, s);
    if (options.mode === "isolated-test") {
      assert(
        options.config && options.mongoUriFile,
        "Test config and MongoDB URI file are required",
      );
      s = isolated(
        s,
        readJSON(options.config),
        fs.readFileSync(options.mongoUriFile, "utf8").trim(),
      );
      if (options.additionalCaFile) {
        const ca = fs.readFileSync(options.additionalCaFile, "utf8");
        assert(
          ca.includes("BEGIN CERTIFICATE") && !ca.includes("PRIVATE KEY"),
          "Additional CA file must contain public certificates only",
        );
        fs.writeFileSync(path.join(stage, "additional-server-ca.pem"), ca, {
          mode: 0o600,
        });
        s.additionalServerCA = true;
      }
      json(path.join(stage, "state.json"), s);
      // Never leave runnable production connection files in a test restore.
      require("./render.cjs").render(stage, s);
    }
    json(path.join(stage, "restore-receipt.json"), {
      ...manifest,
      mode: options.mode,
      restoredAt: new Date().toISOString(),
    });
    fs.unlinkSync(path.join(stage, "recovery-manifest.json"));
    for (const name of fs.readdirSync(stage))
      fs.renameSync(path.join(stage, name), path.join(root, name));
    fs.rmdirSync(stage);
    return s;
  } catch (error) {
    child.kill();
    await completed.catch(() => {});
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
module.exports = {
  exportState,
  restoreState,
  pack,
  unpack,
  header,
  hashFile,
  isolated,
};
