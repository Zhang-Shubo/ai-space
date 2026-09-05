import type { Manifest, ManifestTask } from "../../scheduler/manifest.ts";
import { scheduleFor } from "./spec.ts";
import { type BackupSpec, DEFAULT_SPEC, SPACE_APP } from "./types.ts";

/**
 * Backups are scheduler tasks. Each app gets a `backup` command task that runs
 * `bun src/index.ts backup <app>` in a separate process, so the scheduler's
 * timeout, backoff, concurrency limit and notifications apply and the run
 * shows in the panel like any other. ai-space itself owns a `backup` task for
 * space.db and the weekly `backup-verify`.
 */

export const BACKUP_TASK = "backup";
export const VERIFY_TASK = "backup-verify";

export type TaskDefaults = {
  /** Cron for app backups; each app gets its own minute (see `scheduleFor`). */
  schedule: string;
  verifySchedule: string;
  timeoutMs: number;
  /** Absolute path of the bun binary and of ai-space's entry file. */
  bun: string;
  entry: string;
  /** Directory the commands run in: the ai-space checkout. */
  spaceRoot: string;
  /** Workspace home the subprocess must use. */
  home: string;
};

export function backupTask(app: string, spec: BackupSpec, d: TaskDefaults): ManifestTask | undefined {
  if (!spec.enabled) return undefined;
  return {
    name: BACKUP_TASK,
    description: `Snapshot ${app}'s data directory to the backup target`,
    schedule: { kind: "cron", expr: scheduleFor(app, spec, d.schedule), ...(spec.timezone ? { tz: spec.timezone } : {}) },
    target: command(d, ["backup", app]),
    timeoutMs: d.timeoutMs,
    enabled: true,
  };
}

/** ai-space's own tasks, as a manifest the scheduler can sync. */
export function spaceManifest(d: TaskDefaults, spec: BackupSpec = DEFAULT_SPEC): Manifest {
  const tasks: ManifestTask[] = [];
  const own = backupTask(SPACE_APP, spec, d);
  if (own) tasks.push({ ...own, description: "Snapshot space.db to the backup target" });
  tasks.push({
    name: VERIFY_TASK,
    description: "Download the newest snapshot of every app, open it, and fail on any app without a fresh, sound backup",
    schedule: { kind: "cron", expr: d.verifySchedule },
    target: command(d, [VERIFY_TASK]),
    timeoutMs: d.timeoutMs * 2,
    enabled: true,
  });
  return { app: SPACE_APP, dir: d.spaceRoot, spec: 1, title: "ai-space", status: "active", agents: [], widgets: [], tasks };
}

function command(d: TaskDefaults, args: string[]): ManifestTask["target"] {
  return { kind: "command", command: [d.bun, d.entry, ...args].map(shellQuote).join(" "), cwd: d.spaceRoot, env: { SPACE_HOME: d.home } };
}

function shellQuote(v: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}
