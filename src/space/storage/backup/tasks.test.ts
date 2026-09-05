import { describe, expect, test } from "bun:test";
import { parseBackupSpec } from "./spec.ts";
import { BACKUP_TASK, type TaskDefaults, VERIFY_TASK, backupTask, spaceManifest } from "./tasks.ts";

const d: TaskDefaults = { schedule: "0 3 * * *", verifySchedule: "0 5 * * 1", timeoutMs: 60_000, bun: "/home/me/.bun/bin/bun", entry: "/home/me/.ai-space/core/src/index.ts", spaceRoot: "/home/me/.ai-space/core", home: "/home/me/.ai-space" };

describe("backupTask", () => {
  test("a command task in the ai-space checkout with the workspace pinned", () => {
    const t = backupTask("keep", parseBackupSpec(undefined), d)!;
    expect(t.name).toBe(BACKUP_TASK);
    expect(t.schedule).toEqual({ kind: "cron", expr: expect.stringMatching(/^\d+ 3 \* \* \*$/) });
    expect(t.target).toEqual({ kind: "command", command: "/home/me/.bun/bin/bun /home/me/.ai-space/core/src/index.ts backup keep", cwd: d.spaceRoot, env: { SPACE_HOME: d.home } });
    expect(t.timeoutMs).toBe(60_000);
    expect(t.enabled).toBe(true);
  });

  test("quotes paths that need it and honours the manifest's schedule and timezone", () => {
    const t = backupTask("keep", parseBackupSpec({ schedule: "10 2 * * *", timezone: "Asia/Seoul" }), { ...d, bun: "/opt/my tools/bun" })!;
    expect(t.schedule).toEqual({ kind: "cron", expr: "10 2 * * *", tz: "Asia/Seoul" });
    expect((t.target as { command: string }).command).toStartWith("'/opt/my tools/bun' ");
  });

  test("opting out yields no task", () => {
    expect(backupTask("keep", parseBackupSpec(false), d)).toBeUndefined();
  });
});

describe("spaceManifest", () => {
  test("carries the space.db snapshot and the verification", () => {
    const m = spaceManifest(d);
    expect(m.app).toBe("space");
    expect(m.tasks.map((t) => t.name)).toEqual([BACKUP_TASK, VERIFY_TASK]);
    expect((m.tasks[1]!.target as { command: string }).command).toEndWith(" backup-verify");
    expect(m.tasks[1]!.schedule).toEqual({ kind: "cron", expr: "0 5 * * 1" });
  });
});
