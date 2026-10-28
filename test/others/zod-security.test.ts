import { z } from "zod";
import { ObjectId } from "mongodb";
import { ObjectIdSchema } from "../../src/utils";
import { defaultSchema } from "../../src/handlers/defaults/utils";

// GHSA-mrhx-c7xc-m3w5: bounded collections must reject oversized inputs
// before visiting children or allocating an error for every invalid element.
describe("Patched Zod collection limits", () => {
  test.each(["max", "length"] as const)(
    "%s rejects oversized arrays with one issue",
    (limit) => {
      const schema = z.array(z.string())[limit](1);
      const result = schema.safeParse(Array(10000).fill(0));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0].code).toBe("too_big");
      }
      expect(schema.parse(["valid"])).toEqual(["valid"]);
      expect(schema.safeParse([0]).success).toBe(false);
    },
  );

  test("oversized sets skip element validators, while valid sets still validate", () => {
    const child = jest.fn();
    const schema = z.set(z.string().superRefine(child)).max(1);
    expect(schema.safeParse(new Set(["one", "two"])).success).toBe(false);
    expect(child).not.toHaveBeenCalled();
    expect(schema.parse(new Set(["one"]))).toEqual(new Set(["one"]));
    expect(child).toHaveBeenCalledTimes(1);
  });
});

describe("Zod 4 compatibility", () => {
  test("ObjectId transforms and custom errors remain intact", () => {
    const id = new ObjectId();
    expect(ObjectIdSchema.parse(id.toHexString())).toEqual(id);
    expect(ObjectIdSchema.parse(id)).toEqual(id);
    const invalid = ObjectIdSchema.safeParse("invalid");
    expect(invalid.success).toBe(false);
    if (!invalid.success)
      expect(invalid.error.issues[0].message).toBe("Invalid ObjectId");
  });

  test("optional options and top-level unknown-field stripping remain intact", () => {
    const input = {
      dataSource: "local",
      database: "test",
      collection: "users",
    };
    expect(defaultSchema.parse({ ...input, ignored: true })).toEqual(input);
    expect(
      defaultSchema.parse({ ...input, options: { projection: { name: 1 } } })
        .options,
    ).toEqual({ projection: { name: 1 } });
  });

  test("absent environment values retain their defaults", () => {
    const keys = [
      "APP_NAME",
      "DATA_SOURCES",
      "JWT_SECRET",
      "SERVER_ADDRESS",
      "SERVER_PORT",
    ];
    const saved = keys.map((key) => process.env[key]);
    try {
      keys.forEach((key) => delete process.env[key]);
      jest.isolateModules(() => {
        const { envs } = require("../../src/envs");
        expect(envs).toEqual({
          APP_NAME: "delbridge-typescript-data-api",
          DATA_SOURCES: { local: "mongodb://127.0.0.1:27017" },
          JWT_SECRET: "something-secure",
          SERVER_ADDRESS: "127.0.0.1",
          SERVER_PORT: 8080,
        });
      });
    } finally {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
    }
  });
});
