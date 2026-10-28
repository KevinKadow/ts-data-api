// Explicit operator command; does not run during API startup.
const { MongoClient } = require("mongodb");
(async () => {
  if (!process.env.READER_DATABASE || !process.env.READER_DATA_SOURCE)
    throw Error("Reader database configuration required");
  const sources = JSON.parse(process.env.DATA_SOURCES || "{}");
  const client = new MongoClient(sources[process.env.READER_DATA_SOURCE]);
  try {
    const db = client.db(process.env.READER_DATABASE);
    await db
      .collection("nfc_readers")
      .createIndex({ name: 1 }, { unique: true });
    await db
      .collection("nfc_readers")
      .createIndex({ certificateFingerprint: 1 }, { unique: true });
  } finally {
    await client.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
