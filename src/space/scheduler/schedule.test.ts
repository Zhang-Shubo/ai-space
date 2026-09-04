import { describe, expect, test } from "bun:test";
import { assertSchedule, nextRunAt, parseDuration } from "./schedule.ts";

const T0 = Date.parse("2026-09-04T00:00:00Z");

describe("nextRunAt", () => {
  test("at: future timestamp returns it, past returns undefined", () => {
    expect(nextRunAt({ kind: "at", at: "2026-09-04T01:00:00Z" }, T0)).toBe(T0 + 3_600_000);
    expect(nextRunAt({ kind: "at", at: "2026-09-03T23:00:00Z" }, T0)).toBeUndefined();
    expect(nextRunAt({ kind: "at", at: "not a date" }, T0)).toBeUndefined();
  });

  test("every: aligns to anchor + k * interval, strictly after now", () => {
    const s = { kind: "every", everyMs: 1000, anchorMs: T0 } as const;
    expect(nextRunAt(s, T0)).toBe(T0 + 1000);
    expect(nextRunAt(s, T0 + 999)).toBe(T0 + 1000);
    expect(nextRunAt(s, T0 + 1000)).toBe(T0 + 2000);
    expect(nextRunAt(s, T0 + 4500)).toBe(T0 + 5000);
  });

  test("every: before the anchor returns the anchor itself", () => {
    expect(nextRunAt({ kind: "every", everyMs: 1000, anchorMs: T0 + 5000 }, T0)).toBe(T0 + 5000);
  });

  test("cron: honors timezone", () => {
    const next = nextRunAt({ kind: "cron", expr: "30 14 * * *", tz: "Asia/Seoul" }, T0);
    // 14:30 KST is 05:30 UTC.
    expect(next).toBe(Date.parse("2026-09-04T05:30:00Z"));
  });

  test("cron: never returns now or earlier", () => {
    const atMinute = Date.parse("2026-09-04T00:05:00Z");
    const next = nextRunAt({ kind: "cron", expr: "*/5 * * * *" }, atMinute);
    expect(next).toBeGreaterThan(atMinute);
    expect(next).toBe(atMinute + 5 * 60_000);
  });
});

describe("assertSchedule", () => {
  test("rejects bad input with readable errors", () => {
    expect(() => assertSchedule({ kind: "cron", expr: "99 99 * * *" })).toThrow(/invalid cron/);
    expect(() => assertSchedule({ kind: "every", everyMs: 0 })).toThrow(/invalid every/);
    expect(() => assertSchedule({ kind: "at", at: "nope" })).toThrow(/invalid at/);
  });

  test("accepts good input", () => {
    expect(() => assertSchedule({ kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Seoul" })).not.toThrow();
    expect(() => assertSchedule({ kind: "every", everyMs: 60_000 })).not.toThrow();
  });
});

describe("parseDuration", () => {
  test("parses units", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("6h")).toBe(6 * 3_600_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration(5000)).toBe(5000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
  });

  test("rejects garbage", () => {
    expect(() => parseDuration("soon")).toThrow();
    expect(() => parseDuration("0m")).toThrow();
    expect(() => parseDuration(-1)).toThrow();
  });
});
