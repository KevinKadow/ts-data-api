const fs = require("node:fs");
const { spawn } = require("node:child_process");
const names = [
  "DATA_SOURCES",
  "JWT_SECRET",
  "READER_PROXY_SECRET",
  "READER_KEY_ENCRYPTION_KEY",
  "READER_MQTT_PASSWORD",
  "READER_RESERVATION_SERVICE_SECRET",
];
for (const name of names) {
  if (!process.env[name + "_FILE"]) continue;
  const value = fs.readFileSync(process.env[name + "_FILE"], "utf8").trim();
  if (!value) throw new Error(`Empty secret: ${name}`);
  process.env[name] = value;
}
const child = spawn(process.argv[2], process.argv.slice(3), {
  stdio: "inherit",
  env: process.env,
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("error", () => {
  console.error("Application could not start");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
