const fs = require("node:fs");
const { MongoClient } = require("mongodb");
const jwt = require("jsonwebtoken");
(async () => {
  const secret = fs.readFileSync(process.env.JWT_SECRET_FILE, "utf8").trim();
  const sources = JSON.parse(
    fs.readFileSync(process.env.DATA_SOURCES_FILE, "utf8"),
  );
  const response = await fetch("http://127.0.0.1:8080/", {
    headers: {
      Authorization: "Bearer " + jwt.sign({}, secret, { expiresIn: 15 }),
    },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw Error("HTTP unavailable");
  const client = new MongoClient(sources[process.env.READER_DATA_SOURCE], {
    serverSelectionTimeoutMS: 3000,
  });
  try {
    await client.db(process.env.READER_DATABASE).command({ ping: 1 });
  } finally {
    await client.close();
  }
})().catch(() => {
  console.error("API/database health check failed");
  process.exitCode = 1;
});
