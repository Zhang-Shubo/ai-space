import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "../../workspace.ts";
import { createArchive, requireArchiveTools } from "./archive.ts";
import { listSnapshots } from "./catalog.ts";
import { selectRetained } from "./retention.ts";
import { stageSnapshot } from "./snapshot.ts";
import type { BackupStore } from "./store.ts";
import type { BackupTarget } from "./target.ts";
import { type BackupSpec, type Keep, type SnapshotManifest, archiveKey, sidecarKey, stamp } from "./types.ts";

/**
 * One backup run: stage → archive → upload → record → prune. Everything on
 * disk lives under `<workspace>/backups/<app>/` and is removed at the end,
 * success or failure; a lock file keeps two runs of one app apart.
 */

export type BackupDeps = {
  ws: Workspace;
  target: BackupTarget;
  store: BackupStore;
  log?: (message: string) => void;
  now?: () => Date;
};

export type BackupJob = {
  app: string;
  dataDir: string;
  spec: BackupSpec;
  appDir?: string;
  shallow?: boolean;
  postgres?: { name: string; url: string }[];
  blobUrl?: string;
};

export type BackupResult = {
  key: string;
  at: string;
  bytes: number;
  sha256: string;
  entries: number;
  durationMs: number;
  skipped: string[];
  pruned: string[];
};

export function stagingRoot(ws: Workspace): string {
  return join(ws.home, "backups");
}

export async function runBackup(deps: BackupDeps, job: BackupJob): Promise<BackupResult> {
  requireArchiveTools();
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const started = Date.now();
  const root = stagingRoot(deps.ws);
  const appRoot = join(root, job.app);
  const lock = join(root, `${job.app}.lock`);
  await mkdir(root, { recursive: true });
  await acquireLock(lock, job.app);
  const key = archiveKey(job.app, now);
  try {
    await rm(appRoot, { recursive: true, force: true }); // leftovers of a killed run
    const stageDir = join(appRoot, stamp(now));
    const archivePath = `${stageDir}.tar.zst`;

    const manifest = await stageSnapshot({ app: job.app, dataDir: job.dataDir, stageDir, spec: job.spec, appDir: job.appDir, shallow: job.shallow, postgres: job.postgres, blobUrl: job.blobUrl, now });
    log(`${job.app}: staged ${manifest.entries.length} entries`);
    const archive = await createArchive(stageDir, archivePath);
    await rm(stageDir, { recursive: true, force: true });
    const sidecar: SnapshotManifest = { ...manifest, key, archive };
    log(`${job.app}: archive ${formatBytes(archive.bytes)}, uploading to ${deps.target.url}${key}`);
    await deps.target.put(key, archivePath);
    await deps.target.putText(sidecarKey(key), JSON.stringify(sidecar, null, 2));
    const durationMs = Date.now() - started;
    await deps.store.record({ app: job.app, key, at: now.getTime(), bytes: archive.bytes, sha256: archive.sha256, status: "ok", durationMs, entries: manifest.entries.length });

    const pruned = await pruneApp(deps, job.app, job.spec.keep);
    if (pruned.length) log(`${job.app}: pruned ${pruned.length} old snapshot(s)`);
    return { key, at: manifest.at, bytes: archive.bytes, sha256: archive.sha256, entries: manifest.entries.length, durationMs, skipped: manifest.skipped, pruned };
  } catch (e) {
    const error = (e as Error).message ?? String(e);
    await deps.store.record({ app: job.app, key, at: now.getTime(), bytes: 0, sha256: "", status: "error", error, durationMs: Date.now() - started, entries: 0 }).catch(() => {});
    throw e;
  } finally {
    await rm(appRoot, { recursive: true, force: true });
    await rm(lock, { force: true });
  }
}

/** Delete the snapshots retention does not keep. Only keys with a sidecar in this module's format are candidates. */
export async function pruneApp(deps: BackupDeps, app: string, keep: Keep): Promise<string[]> {
  const refs = await listSnapshots(deps.target, app);
  const candidates = [];
  for (const r of refs) {
    const row = await deps.store.get(r.key);
    candidates.push({ key: r.key, at: r.at.getTime(), failed: row?.verifyOk === false });
  }
  const { drop } = selectRetained(candidates, keep);
  for (const key of drop) {
    await deps.target.delete(key);
    await deps.target.delete(sidecarKey(key));
    await deps.store.remove(key);
  }
  return drop;
}

async function acquireLock(lock: string, app: string): Promise<void> {
  try {
    const pid = Number((await readFile(lock, "utf8")).trim());
    if (pid && alive(pid)) throw new Error(`backup of ${app} is already running (pid ${pid})`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await Bun.write(lock, String(process.pid));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
