import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadManifest } from "../../scheduler/manifest.ts";
import { runStopCommand } from "../../panel/index.ts";
import type { Workspace } from "../../workspace.ts";
import { openDatabase, sqliteUrl } from "../db.ts";
import type { StorageService } from "../storage.ts";
import type { S3Config } from "../types.ts";
import { listSnapshots } from "./catalog.ts";
import { restoreSnapshot } from "./restore.ts";
import { type BackupDeps, type BackupJob, formatBytes, runBackup } from "./run.ts";
import { parseBackupSpec } from "./spec.ts";
import { BackupStore } from "./store.ts";
import { openBackupTarget } from "./target.ts";
import { type BackupSpec, DEFAULT_SPEC, SPACE_APP, stamp } from "./types.ts";
import { verifyAll } from "./verify.ts";

/**
 * The backup subcommands. They run in their own process, both when the
 * scheduler's task fires and when an operator types them:
 *
 *   bun src/index.ts backup <app>                         snapshot one app (or `space` for space.db)
 *   bun src/index.ts backup-verify [<app>…]               verify the newest snapshot of every app (or the named ones)
 *   bun src/index.ts backups [<app>]                      list snapshots in the target
 *   bun src/index.ts restore <app> [--at <time>] --to <dir>
 *   bun src/index.ts restore <app> [--at <time>] --in-place [--stopped]
 */

export type CliContext = {
  ws: Workspace;
  dbPath: string;
  s3?: S3Config;
  backupUrl: string;
  backupMaxAgeMs: number;
  /** SPACE_SERVICE_STOP, used by `restore --in-place`. */
  serviceStop: string;
  /** Every app directory in the workspace. */
  appDirs: () => Promise<string[]>;
  storage: StorageService;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

export const BACKUP_COMMANDS = ["backup", "backup-verify", "backups", "restore"] as const;
export type BackupCommand = (typeof BACKUP_COMMANDS)[number];

export async function backupCli(command: BackupCommand, argv: string[], ctx: CliContext): Promise<number> {
  const out = ctx.out ?? ((l) => console.log(l));
  const err = ctx.err ?? ((l) => console.error(l));
  if (!ctx.backupUrl) {
    err("[backup] SPACE_BACKUP_URL is not set (and no SPACE_S3_BUCKET to derive it from); see docs/backup.md");
    return 2;
  }
  const db = await openDatabase(sqliteUrl(ctx.dbPath));
  try {
    const deps: BackupDeps = { ws: ctx.ws, target: openBackupTarget(ctx.backupUrl, ctx.s3), store: await BackupStore.open(db), log: (m) => err(`[backup] ${m}`) };
    switch (command) {
      case "backup":
        return await backupOne(argv, ctx, deps, out, err);
      case "backup-verify":
        return await verify(argv, ctx, deps, out, err);
      case "backups":
        return await list(argv, deps, out);
      case "restore":
        return await restore(argv, ctx, deps, out, err);
    }
  } catch (e) {
    err(`[backup] ${(e as Error).message ?? String(e)}`);
    return 1;
  } finally {
    await db.close();
  }
}

async function backupOne(argv: string[], ctx: CliContext, deps: BackupDeps, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  const app = argv[0];
  if (!app || argv.length > 1) {
    err("[backup] usage: bun src/index.ts backup <app>");
    return 2;
  }
  const job = await jobFor(app, ctx);
  if (!job.spec.enabled) err(`[backup] ${app}: backup is disabled in space.yaml; running anyway because you asked`);
  const r = await runBackup(deps, job);
  for (const s of r.skipped) err(`[backup] ${app}: ${s}`);
  out(`${app}: ${r.entries} entries, ${formatBytes(r.bytes)} → ${deps.target.url}${r.key} in ${(r.durationMs / 1000).toFixed(1)}s${r.pruned.length ? `; pruned ${r.pruned.length}` : ""}`);
  return 0;
}

async function verify(argv: string[], ctx: CliContext, deps: BackupDeps, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  const apps = argv.length ? argv : await backedUpApps(ctx);
  const { ok, results } = await verifyAll(deps, apps, { maxAgeMs: ctx.backupMaxAgeMs });
  for (const r of results) {
    out(`${r.ok ? "ok  " : "FAIL"} ${r.app}${r.at ? ` ${stamp(new Date(r.at))}` : ""}${r.checks.length ? `  ${r.checks.join(", ")}` : ""}`);
    for (const e of r.errors) err(`     ${r.app}: ${e}`);
  }
  out(`${results.filter((r) => r.ok).length}/${results.length} apps verified`);
  return ok ? 0 : 1;
}

async function list(argv: string[], deps: BackupDeps, out: (l: string) => void): Promise<number> {
  const refs = await listSnapshots(deps.target, argv[0]);
  if (refs.length === 0) {
    out(`no snapshots${argv[0] ? ` of ${argv[0]}` : ""} in ${deps.target.url}`);
    return 0;
  }
  const width = Math.max(...refs.map((r) => r.app.length));
  for (const r of refs) {
    const row = await deps.store.get(r.key);
    const verified = row?.verifiedAt ? (row.verifyOk ? "verified" : `FAILED verify: ${row.verifyError ?? ""}`) : "";
    out(`${r.app.padEnd(width)}  ${stamp(r.at)}  ${formatBytes(r.bytes).padStart(9)}  ${verified}`.trimEnd());
  }
  return 0;
}

async function restore(argv: string[], ctx: CliContext, deps: BackupDeps, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  const usage = "[backup] usage: bun src/index.ts restore <app> [--at <time>] (--to <dir> | --in-place [--stopped])";
  const app = argv[0];
  if (!app || app.startsWith("--")) {
    err(usage);
    return 2;
  }
  let at: string | undefined;
  let to: string | undefined;
  let inPlace = false;
  let stopped = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--at") at = value();
    else if (a === "--to") to = value();
    else if (a === "--in-place") inPlace = true;
    else if (a === "--stopped") stopped = true;
    else {
      err(usage);
      return 2;
    }
  }
  const stopService = ctx.serviceStop
    ? async (name: string) => {
        const r = await runStopCommand(ctx.serviceStop, name);
        if (!r.ok) throw new Error(`could not stop ${name}: ${r.error ?? "unknown error"}`);
        err(`[backup] stopped ${name}`);
      }
    : undefined;
  const r = await restoreSnapshot(deps, { app, at, to, inPlace, stopped, stopService });
  out(`${app}: restored ${r.key} (${r.files} files) into ${r.dir}`);
  if (r.asideDir) {
    out(`previous data moved to ${r.asideDir}; delete it once the app runs correctly`);
    out(`start the app again (its unit is not managed by ai-space), then POST /api/apps/${app}/sync`);
  }
  for (const e of r.manifest.entries) if (e.kind === "postgres") out(`postgres dump ${e.path} was unpacked, not loaded: pg_restore -d $DATABASE_URL_<NAME> --clean ${join(r.dir, e.path.replace(/^databases\//, ""))}`);
  return 0;
}

/** The job for an app: its data dir, its manifest's backup section, and what the storage inventory knows. */
async function jobFor(app: string, ctx: CliContext): Promise<BackupJob> {
  if (app === SPACE_APP) return { app, dataDir: ctx.ws.data, spec: { ...DEFAULT_SPEC }, shallow: true };
  const dataDir = ctx.storage.appDataDir(app);
  if (!(await isDir(dataDir))) throw new Error(`${app} has no data directory (${dataDir})`);
  const found = await findManifest(app, ctx);
  const spec = parseBackupSpec(found?.backup);
  const postgres = (await ctx.storage.list(app)).filter((d) => d.backend === "postgres" && !d.orphaned).map((d) => ({ name: d.name, url: d.url }));
  const blobs = await ctx.storage.blobStore(app);
  return { app, dataDir, spec, appDir: found?.dir, postgres, ...(blobs && !blobs.orphaned ? { blobUrl: blobs.url } : {}) };
}

async function findManifest(app: string, ctx: CliContext): Promise<{ dir: string; backup?: unknown } | undefined> {
  for (const dir of await ctx.appDirs()) {
    try {
      const m = await loadManifest(dir);
      if (m.app === app) return { dir, backup: m.backup };
    } catch {
      /* an unparsable manifest elsewhere is not this app's problem */
    }
  }
  return undefined;
}

/** `space` plus every app with a data directory whose manifest does not opt out. */
async function backedUpApps(ctx: CliContext): Promise<string[]> {
  const specs = new Map<string, BackupSpec>();
  for (const dir of await ctx.appDirs()) {
    try {
      const m = await loadManifest(dir);
      specs.set(m.app, parseBackupSpec(m.backup));
    } catch {
      /* skipped at boot too */
    }
  }
  const apps = [SPACE_APP];
  for (const name of (await readdir(ctx.ws.data)).sort()) {
    if (!(await isDir(join(ctx.ws.data, name)))) continue;
    if (specs.get(name)?.enabled === false) continue;
    apps.push(name);
  }
  return apps;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
