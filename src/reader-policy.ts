import { DateTime } from "luxon";
export const ROLES = ["door", "garagedoor", "test", "latch", "tool"];
export function checkoutUntil(value: Date | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const day = value.toISOString().slice(0, 10);
  return DateTime.fromISO(day, { zone: "America/New_York" })
    .plus({ days: 1 })
    .startOf("day")
    .toMillis();
}
export function validUid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:[0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$/.test(value)
  );
}
export function effectiveCard(card: any, member: any) {
  const expiry = Math.min(
    Number(card.expiry) || 0,
    Number(member?.expirationTime) || 0,
  );
  const validity =
    card.validity !== "activeMember"
      ? card.validity
      : member?.status !== "activeMember"
        ? member?.status || "unknownMember"
        : "activeMember";
  return { expiry, validity: boundedText(validity, 64) };
}

// Bound by UTF-8 bytes, which are what the ESP32 actually stores.
export function boundedText(value: unknown, limit: number): string {
  let result = "",
    bytes = 0;
  for (const character of String(value ?? "")) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) break;
    result += character;
    bytes += size;
  }
  return result;
}
