import { authenticateReader } from "../../src/routes/readers";
describe("reader authentication boundary", () => {
  const previous = process.env.READER_PROXY_SECRET;
  afterEach(() => {
    if (previous === undefined) delete process.env.READER_PROXY_SECRET;
    else process.env.READER_PROXY_SECRET = previous;
  });
  it("fails closed when proxy authentication is not configured", async () => {
    delete process.env.READER_PROXY_SECRET;
    await expect(authenticateReader({} as any)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
