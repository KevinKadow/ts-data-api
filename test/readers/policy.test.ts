import {
  checkoutUntil,
  effectiveCard,
  validUid,
} from "../../src/reader-policy";
describe("reader policy", () => {
  test("checkout lasts through its NY date including spring DST", () => {
    expect(checkoutUntil(new Date("2026-03-08T00:00:00Z"))).toBe(
      Date.parse("2026-03-09T04:00:00Z"),
    );
  });
  test("fall DST and never-expiring checkout", () => {
    expect(checkoutUntil(new Date("2026-11-01T00:00:00Z"))).toBe(
      Date.parse("2026-11-02T05:00:00Z"),
    );
    expect(checkoutUntil(null)).toBe(Number.MAX_SAFE_INTEGER);
  });
  test("member status and shorter expiry bound a stale card", () => {
    expect(
      effectiveCard(
        { validity: "activeMember", expiry: 200 },
        { status: "revoked", expirationTime: 100 },
      ),
    ).toEqual({ validity: "revoked", expiry: 100 });
    expect(
      effectiveCard(
        { validity: "lost", expiry: 200 },
        { status: "activeMember", expirationTime: 300 },
      ),
    ).toEqual({ validity: "lost", expiry: 200 });
  });
  test("UIDs preserve zeroes and require supported byte lengths", () => {
    expect(validUid("00112233")).toBe(true);
    expect(validUid("00112233445566")).toBe(true);
    for (const value of ["112233", "0011223g", "001122aa", null, 123])
      expect(validUid(value)).toBe(false);
  });
});

test("card text bounds use UTF-8 bytes without splitting characters", () => {
  const { boundedText } = require("../../src/reader-policy");
  const text = boundedText("漢".repeat(256), 256);
  expect(Buffer.byteLength(text)).toBe(255);
  expect(text).toBe("漢".repeat(85));
  expect(boundedText("😀".repeat(100), 256)).toBe("😀".repeat(64));
});
