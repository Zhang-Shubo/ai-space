import { describe, expect, test } from "bun:test";
import { parseManifest } from "../../scheduler/manifest.ts";
import { backupMinute, parseBackupSpec, scheduleFor } from "./spec.ts";
import { DEFAULT_INCLUDE, DEFAULT_KEEP } from "./types.ts";

describe("parseBackupSpec", () => {
  test("absent and true mean the defaults", () => {
    for (const raw of [undefined, null, true]) {
      const s = parseBackupSpec(raw);
      expect(s.enabled).toBe(true);
      expect(s.keep).toEqual(DEFAULT_KEEP);
      expect(s.include).toEqual(DEFAULT_INCLUDE);
      expect(s.exclude).toEqual([]);
      expect(s.schedule).toBeUndefined();
    }
  });

  test("false opts out", () => {
    expect(parseBackupSpec(false).enabled).toBe(false);
  });

  test("a mapping adjusts schedule, retention, sources and excludes", () => {
    const s = parseBackupSpec({ schedule: "30 4 * * *", timezone: "Asia/Seoul", keep: { daily: 3 }, include: ["databases", "blobs"], exclude: ["cache/", "*.tmp"] });
    expect(s).toEqual({ enabled: true, schedule: "30 4 * * *", timezone: "Asia/Seoul", keep: { daily: 3, weekly: 4, monthly: 6 }, include: ["databases", "blobs"], exclude: ["cache/", "*.tmp"] });
  });

  test("rejects what it does not understand", () => {
    expect(() => parseBackupSpec("yes")).toThrow(/true, false or a mapping/);
    expect(() => parseBackupSpec({ nope: 1 })).toThrow(/unknown key "nope"/);
    expect(() => parseBackupSpec({ schedule: "not cron" })).toThrow(/schedule/);
    expect(() => parseBackupSpec({ keep: { daily: -1 } })).toThrow(/non-negative/);
    expect(() => parseBackupSpec({ keep: { daily: 0, weekly: 0, monthly: 0 } })).toThrow(/keeps nothing/);
    expect(() => parseBackupSpec({ include: [] })).toThrow(/non-empty/);
    expect(() => parseBackupSpec({ include: ["logs"] })).toThrow(/one of databases, files, blobs/);
    expect(() => parseBackupSpec({ exclude: ["/etc"] })).toThrow(/relative/);
    expect(() => parseBackupSpec({ exclude: ["../x"] })).toThrow(/relative/);
  });

  test("the manifest passes the section through raw", () => {
    const m = parseManifest("name: a\nbackup: false\n", "/apps/a");
    expect(m.backup).toBe(false);
    expect(parseManifest("name: a\n", "/apps/a").backup).toBeUndefined();
  });
});

describe("scheduleFor", () => {
  test("stable per-app minute inside the workspace hour", () => {
    const minute = backupMinute("keep");
    expect(minute).toBeGreaterThanOrEqual(0);
    expect(minute).toBeLessThan(60);
    expect(backupMinute("keep")).toBe(minute);
    expect(scheduleFor("keep", parseBackupSpec(undefined), "0 3 * * *")).toBe(`${minute} 3 * * *`);
    expect(scheduleFor("keep", parseBackupSpec(undefined), "0 0 3 * * *")).toBe(`0 ${minute} 3 * * *`);
  });

  test("keeps a default that already spreads minutes, and the manifest's own schedule", () => {
    expect(scheduleFor("keep", parseBackupSpec(undefined), "*/30 3 * * *")).toBe("*/30 3 * * *");
    expect(scheduleFor("keep", parseBackupSpec({ schedule: "15 1 * * *" }), "0 3 * * *")).toBe("15 1 * * *");
  });

  test("different apps land on different minutes most of the time", () => {
    const minutes = new Set(["keep", "whymove", "trade-agent", "fin-jargon", "hive", "space"].map(backupMinute));
    expect(minutes.size).toBeGreaterThan(3);
  });
});
