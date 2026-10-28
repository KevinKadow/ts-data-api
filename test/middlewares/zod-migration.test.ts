import { Decimal128, ObjectId } from "mongodb";
import { dataSources } from "../../src/mdb";
import { requester, withDb } from "../helpers";

const base = {
  dataSource: "local",
  database: "test",
  collection: "zodMigration",
};

withDb(() => {
  const collection = dataSources.local
    .db(base.database)
    .collection(base.collection);

  test("nested EJSON BSON values survive arbitrary record validation", async () => {
    const id = new ObjectId();
    const price = Decimal128.fromString("12.34");
    const document = {
      _id: id,
      nested: { price, owner: new ObjectId(), date: new Date(0) },
    };
    const inserted = await requester({
      url: "/defaults/insertOne",
      data: { ...base, document },
    });
    expect(inserted.status).toBe(200);
    const result = await requester({
      url: "/defaults/findOne",
      data: {
        ...base,
        filter: { _id: id },
        options: { projection: { nested: 1 } },
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(document);
  });

  test.each(["updateOne", "updateMany", "findOneAndUpdate"])(
    "%s still accepts update pipelines and MongoDB operator keys",
    async (endpoint) => {
      const { insertedId } = await collection.insertOne({ points: 10 });
      const result = await requester({
        contentType: "application/json",
        url: "/defaults/" + endpoint,
        data: {
          ...base,
          filter: { points: { $gte: 10 } },
          update: [{ $set: { points: { $add: ["$points", 5] } } }],
        },
      });
      expect(result.status).toBe(200);
      expect((await collection.findOne({ _id: insertedId }))?.points).toBe(15);
    },
  );

  test.each([
    ["insertOne", { document: [] }, "document"],
    ["insertMany", { documents: [null] }, "documents"],
    ["aggregate", { pipeline: [0] }, "pipeline"],
    ["bulkWrite", { operations: [false] }, "operations"],
    ["findOne", { filter: [] }, "filter"],
    ["updateOne", { filter: {}, update: "invalid" }, "update"],
    ["replaceOne", { filter: {}, replacement: null }, "replacement"],
    ["findOne", { filter: {}, options: [] }, "options"],
    ["findOne", { filter: {}, dataSource: "missing-source" }, "dataSource"],
    ["findOne", { filter: {}, database: undefined }, "database"],
  ])(
    "%s rejects malformed %s before database writes",
    async (endpoint, fields, field) => {
      const result = await requester({
        url: "/defaults/" + endpoint,
        data: { ...base, ...(fields as object) },
      });
      expect(result.status).toBe(400);
      const prefix = "Body expected not provided: ";
      expect(result.body.message.startsWith(prefix)).toBe(true);
      const errors = JSON.parse(result.body.message.slice(prefix.length));
      expect(errors).toHaveProperty(field as string);
      expect(Array.isArray(errors[field as string])).toBe(true);
      expect(await collection.countDocuments()).toBe(0);
    },
  );

  test("authentication still takes precedence over body validation", async () => {
    const result = await requester({
      url: "/defaults/insertOne",
      token: "invalid",
      data: { document: [] },
    });
    expect(result.status).toBe(401);
    expect(result.body.message).toContain("Invalid Token");
  });

  test("invalid ObjectId transforms return the existing 400 envelope", async () => {
    const result = await requester({
      url: "/custom/transferPoints",
      data: {
        points: 1,
        userOriginId: "bad-id",
        userDestinyId: new ObjectId(),
      },
    });
    expect(result.status).toBe(400);
    expect(result.body.message).toContain("Invalid ObjectId");
  });
});
