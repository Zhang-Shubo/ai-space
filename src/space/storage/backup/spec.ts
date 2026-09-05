import { assertSchedule } from "../../scheduler/schedule.ts";
import { BACKUP_SOURCES, type BackupSource, type BackupSpec, DEFAULT_INCLUDE, DEFAULT_KEEP, DEFAULT_SPEC, type Keep } from "./types.ts";

/**
 * The `backup:` manifest section. Absent means "back up with the defaults";
 * `false` opts out; a mapping adjusts schedule, retention, sources and excludes.
 * Parsing is strict, like the rest of the manifest.
 */

const KEYS = ["enabled", "schedule", "timezone", "keep", "include", "exclude"];

export function parseBackupSpec(raw: unknown, ctx = "backup"): BackupSpec {
  if (raw === undefined || raw === null || raw === true) return { ...DEFAULT_SPEC };
  if (raw === false) return { ...DEFAULT_SPEC, enabled: false };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${ctx} must be true, false or a mapping`);
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!KEYS.includes(key)) throw new Error(`${ctx} has unknown key "${key}"`);

  const enabled = r.enabled === undefined ? true : r.enabled;
  if (typeof enabled !== "boolean") throw new Error(`${ctx}.enabled must be true or false`);

  let timezone: string | undefined;
  if (r.timezone !== undefined) {
    if (typeof r.timezone !== "string" || !r.timezone.trim()) throw new Error(`${ctx}.timezone must be an IANA name`);
    timezone = r.timezone.trim();
  }
  let schedule: string | undefined;
  if (r.schedule !== undefined) {
    if (typeof r.schedule !== "string" || !r.schedule.trim()) throw new Error(`${ctx}.schedule must be a cron expression`);
    schedule = r.schedule.trim();
    try {
      assertSchedule({ kind: "cron", expr: schedule, ...(timezone ? { tz: timezone } : {}) });
    } catch (e) {
      throw new Error(`${ctx}.schedule: ${(e as Error).message}`);
    }
  }

  return {
    enabled,
    ...(schedule ? { schedule } : {}),
    ...(timezone ? { timezone } : {}),
    keep: parseKeep(r.keep, `${ctx}.keep`),
    include: parseInclude(r.include, `${ctx}.include`),
    exclude: parseExclude(r.exclude, `${ctx}.exclude`),
  };
}

function parseKeep(raw: unknown, ctx: string): Keep {
  if (raw === undefined) return { ...DEFAULT_KEEP };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${ctx} must be a mapping of daily / weekly / monthly`);
  const r = raw as Record<string, unknown>;
  const out: Keep = { ...DEFAULT_KEEP };
  for (const [k, v] of Object.entries(r)) {
    if (k !== "daily" && k !== "weekly" && k !== "monthly") throw new Error(`${ctx} has unknown key "${k}"`);
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`${ctx}.${k} must be a non-negative integer`);
    out[k] = v;
  }
  if (out.daily + out.weekly + out.monthly === 0) throw new Error(`${ctx} keeps nothing; set at least one count`);
  return out;
}

function parseInclude(raw: unknown, ctx: string): BackupSource[] {
  if (raw === undefined) return [...DEFAULT_INCLUDE];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${ctx} must be a non-empty list`);
  const out: BackupSource[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !(BACKUP_SOURCES as readonly string[]).includes(v)) throw new Error(`${ctx} entries must be one of ${BACKUP_SOURCES.join(", ")}`);
    if (!out.includes(v as BackupSource)) out.push(v as BackupSource);
  }
  return out;
}

function parseExclude(raw: unknown, ctx: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${ctx} must be a list of patterns`);
  return raw.map((v) => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${ctx} entries must be non-empty strings`);
    const p = v.trim();
    if (p.startsWith("/") || p.includes("..")) throw new Error(`${ctx}: "${p}" must be relative to the data directory`);
    return p;
  });
}

/** A stable minute (0-59) per app, so the apps of one workspace do not all snapshot at once. */
export function backupMinute(app: string): number {
  let h = 2166136261;
  for (const c of app) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 60;
}

/**
 * The cron expression for an app's task: the manifest's own, or the workspace
 * default with the minute field replaced by the app's minute. The minute is only
 * replaced when the default names a plain minute, so `*​/30 3 * * *` stays as written.
 */
export function scheduleFor(app: string, spec: BackupSpec, workspaceDefault: string): string {
  if (spec.schedule) return spec.schedule;
  const fields = workspaceDefault.trim().split(/\s+/);
  const minuteIndex = fields.length === 6 ? 1 : 0;
  if (/^\d{1,2}$/.test(fields[minuteIndex] ?? "")) fields[minuteIndex] = String(backupMinute(app));
  return fields.join(" ");
}
