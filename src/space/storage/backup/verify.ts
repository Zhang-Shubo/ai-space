import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { extractArchive, hashFile, listArchive } from "./archive.ts";
import { listSnapshots, readSidecar } from "./catalog.ts";
import type { BackupDeps } from "./run.ts";
import { stagingRoot } from "./run.ts";
import { MANIFEST_NAME } from "./snapshot.ts";
import { type SnapshotManifest, sidecarKey } from "./types.ts";

/**
 * A snapshot that was never opened is not a backup. Verification downloads
 * the newest snapshot of an app, checks the hash, unpacks it, opens every
 * database copy and compares the listing with the manifest inside. The result
 * goes into the index and back into the sidecar.
 */

export type VerifyResult = {
  app: string;
  ok: boolean;
  key?: string;
  at?: string;
  errors: string[];
  checks: string[];
};

export type VerifyOptions = {
  /** Newest successful snapshot older than this fails the app. */
  maxAgeMs: number;
  now?: () => Date;
};

export async function verifyApp(deps: BackupDeps, app: string, opts: VerifyOptions): Promise<VerifyResult> {
  const now = (opts.now ?? (() => new Date()))();
  const result: VerifyResult = { app, ok: false, errors: [], checks: [] };
  const [newest] = await listSnapshots(deps.target, app);
  if (!newest) {
    result.errors.push("no snapshot in the target");
    return result;
  }
  result.key = newest.key;
  result.at = newest.at.toISOString();
  const age = now.getTime() - newest.at.getTime();
  if (age > opts.maxAgeMs) result.errors.push(`newest snapshot is ${Math.round(age / 3600_000)} h old`);
  else result.checks.push(`age ${Math.round(age / 3600_000)} h`);

  const work = join(stagingRoot(deps.ws), "verify", app);
  await rm(work, { recursive: true, force: true });
  let sidecar: SnapshotManifest | undefined;
  try {
    sidecar = await readSidecar(deps.target, newest.key);
    if (!sidecar) throw new Error("sidecar missing");
    const archivePath = join(work, "snapshot.tar.zst");
    await deps.target.get(newest.key, archivePath);
    const { bytes, sha256 } = await hashFile(archivePath);
    if (sidecar.archive && sidecar.archive.sha256 !== sha256) result.errors.push(`archive sha256 ${sha256.slice(0, 12)}… differs from the sidecar's ${sidecar.archive.sha256.slice(0, 12)}…`);
    else result.checks.push(`sha256 ok (${bytes} bytes)`);

    const dir = join(work, "unpacked");
    await extractArchive(archivePath, dir);
    const listed = new Set(await listArchive(archivePath));
    const expected = new Set(sidecar.entries.map((e) => e.path));
    for (const p of expected) if (!listed.has(p)) result.errors.push(`missing from archive: ${p}`);
    for (const p of listed) if (!expected.has(p) && p !== MANIFEST_NAME) result.errors.push(`not in manifest: ${p}`);
    if (![...expected].some((p) => !listed.has(p))) result.checks.push(`${expected.size} entries listed`);

    for (const e of sidecar.entries) {
      const path = join(dir, e.path);
      if (e.kind === "sqlite") {
        const problem = integrityCheck(path);
        if (problem) result.errors.push(`${e.path}: ${problem}`);
        else result.checks.push(`${e.path}: integrity ok`);
      } else if (e.kind === "postgres") {
        const problem = await pgRestoreList(path);
        if (problem) result.errors.push(`${e.path}: ${problem}`);
        else result.checks.push(`${e.path}: pg_restore --list ok`);
      } else {
        const { sha256 } = await hashFile(path);
        if (sha256 !== e.sha256) result.errors.push(`${e.path}: sha256 differs from the manifest`);
      }
    }
  } catch (e) {
    result.errors.push((e as Error).message ?? String(e));
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  result.ok = result.errors.length === 0;
  const verify = { at: now.toISOString(), ok: result.ok, ...(result.ok ? {} : { error: result.errors.join("; ") }) };
  if (sidecar) {
    if (!(await deps.store.get(newest.key))) await deps.store.index({ ...sidecar, key: newest.key });
    await deps.store.setVerify(newest.key, { at: now.getTime(), ok: verify.ok, error: verify.error });
    await deps.target.putText(sidecarKey(newest.key), JSON.stringify({ ...sidecar, key: newest.key, verify }, null, 2)).catch(() => {});
  }
  return result;
}

export async function verifyAll(deps: BackupDeps, apps: string[], opts: VerifyOptions): Promise<{ ok: boolean; results: VerifyResult[] }> {
  const results: VerifyResult[] = [];
  for (const app of apps) results.push(await verifyApp(deps, app, opts));
  return { ok: results.every((r) => r.ok), results };
}

/** undefined when the database passes `PRAGMA integrity_check`. */
export function integrityCheck(path: string): string | undefined {
  let db: Database | undefined;
  try {
    try {
      db = new Database(path, { readonly: true });
      db.query("PRAGMA schema_version").get();
    } catch {
      db?.close();
      db = new Database(path, { readwrite: true, create: false });
    }
    const rows = db.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
    const verdict = rows.map((r) => r.integrity_check).join("; ");
    return verdict === "ok" ? undefined : verdict || "integrity_check returned nothing";
  } catch (e) {
    return (e as Error).message;
  } finally {
    db?.close();
  }
}

async function pgRestoreList(path: string): Promise<string | undefined> {
  if (!Bun.which("pg_restore")) return "pg_restore is not on PATH";
  const proc = Bun.spawn(["pg_restore", "--list", path], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  return (await proc.exited) === 0 ? undefined : stderr.trim();
}
