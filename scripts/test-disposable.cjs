const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { spawn } = require("node:child_process");
(async () => {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  try {
    const args = [
      require.resolve("jest/bin/jest"),
      "--runInBand",
      ...process.argv.slice(2),
    ];
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        DATA_SOURCES: JSON.stringify({ local: repl.getUri() }),
        JWT_SECRET: "something-secure",
      },
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await repl.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
