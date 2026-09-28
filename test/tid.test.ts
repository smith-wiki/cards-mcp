import { describe, expect, it } from "vitest";
import { TID_PATTERN, encodeTid, generateTid, tidCreated, tidMicros } from "../src/tid";

describe("Card ID (TID)", () => {
  it("is 13 sortable base32 characters", () => {
    const id = generateTid(Date.parse("2026-09-28T14:03:22.417Z"));
    expect(id).toHaveLength(13);
    expect(id).toMatch(TID_PATTERN);
  });

  it("round-trips the creation timestamp", () => {
    const now = Date.parse("2027-01-02T03:04:05.678Z");
    expect(tidCreated(generateTid(now))).toBe("2027-01-02T03:04:05.678Z");
    expect(tidMicros(encodeTid(1_790_000_000_123_456, 1023))).toBe(1_790_000_000_123_456);
  });

  it("sorts as strings in time order, regardless of clock id", () => {
    const earlier = encodeTid(1_790_000_000_000_000, 1023);
    const later = encodeTid(1_790_000_000_000_001, 0);
    expect(earlier < later).toBe(true);
  });

  it("never repeats or goes backwards within an isolate", () => {
    const now = Date.parse("2031-01-01T00:00:00Z");
    const ids = Array.from({ length: 2000 }, () => generateTid(now));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
