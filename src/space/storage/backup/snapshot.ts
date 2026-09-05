import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { hashFile } from "./archive.ts";
import { type BackupSpec, DEFAULT_EXCLUDES, type SnapshotEntry, type SnapshotManifest } from "./types.ts";

/**
 * Staging: copy everything a snapshot contains into one directory, laid out
 * so a restore is a copy back:
 *
 *   databases/<rel>.db     VACUUM INTO of every SQLite file, consistent under WAL
 *   databases/<name>.pgdump pg_dump -Fc of every provisioned postgres database
 *   files/<rel>            every other file in the data dir, minus excludes
 *   blobs/<rel>            the filesystem blob store, when `include` names blobs
 *   space.yaml             the app manifest at snapshot time
 *   manifest.json          what is in here, with sizes and hashes
 */

export type SnapshotInput = {
  app: string;
  dataDir: string;
  stageDir: string;
  spec: BackupSpec;
  /** The app directory, for its space.yaml. */
  appDir?: string;
  /** Top-level files only (ai-space's own data dir, whose subdirectories are the apps). */
  shallow?: boolean;
  postgres?: { name: string; url: string }[];
  blobUrl?: string;
  now?: Date;
};

export const STAGE_DATABASES = "databases";
export const STAGE_FILES = "files";
export const STAGE_BLOBS = "blobs";
export const MANIFEST_NAME = "manifest.json";

export async function stageSnapshot(input: SnapshotInput): Promise<SnapshotManifest> {
  const { app, dataDir, stageDir, spec } = input;
  const at = (input.now ?? new Date()).toISOString();
  const excluded = [...DEFAULT_EXCLUDES, ...spec.exclude];
  const matcher = excludeMatcher(excluded);
  const manifest: SnapshotManifest = { version: 1, app, at, entries: [], excluded, skipped: [], ...(input.blobUrl ? { blobUrl: input.blobUrl } : {}) };
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  const wantDatabases = spec.include.includes("databases");
  const wantFiles = spec.include.includes("files");
  const wantBlobs = spec.include.includes("blobs");

  const walk = async (dir: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const s = await stat(path).catch(() => undefined);
      if (!s) continue;
      if (s.isDirectory()) {
        if (input.shallow || matcher(relPath, true)) continue;
        await walk(path, relPath);
        continue;
      }
      if (!s.isFile() || matcher(relPath, false)) continue;
      if (name.endsWith(".db")) {
        if (!wantDatabases) continue;
        const dest = join(stageDir, STAGE_DATABASES, relPath);
        await mkdir(dirname(dest), { recursive: true });
        try {
          snapshotSqlite(path, dest);
          manifest.entries.push({ kind: "sqlite", path: `${STAGE_DATABASES}/${relPath}`, ...(await hashFile(dest)) });
        } catch (e) {
          // Not a SQLite file after all (an app's own export, say): keep it as a plain file.
          await rm(dest, { force: true });
          manifest.skipped.push(`${relPath}: not a SQLite database (${(e as Error).message}); copied as a file`);
          if (wantFiles) manifest.entries.push(await copyEntry("file", path, join(stageDir, STAGE_FILES, relPath), `${STAGE_FILES}/${relPath}`));
        }
        continue;
      }
      if (!wantFiles) continue;
      manifest.entries.push(await copyEntry("file", path, join(stageDir, STAGE_FILES, relPath), `${STAGE_FILES}/${relPath}`));
    }
  };
  await walk(dataDir, "");

  if (wantDatabases) {
    for (const pg of input.postgres ?? []) {
      const dest = join(stageDir, STAGE_DATABASES, `${pg.name}.pgdump`);
      await mkdir(dirname(dest), { recursive: true });
      await pgDump(pg.url, dest);
      manifest.entries.push({ kind: "postgres", path: `${STAGE_DATABASES}/${pg.name}.pgdump`, ...(await hashFile(dest)) });
    }
  }

  const blobDir = join(dataDir, STAGE_BLOBS);
  if (wantBlobs && !input.shallow) {
    if (await isDir(blobDir)) {
      const copyTree = async (dir: string, rel: string) => {
        for (const name of (await readdir(dir)).sort()) {
          const path = join(dir, name);
          const relPath = rel ? `${rel}/${name}` : name;
          const s = await stat(path);
          if (s.isDirectory()) await copyTree(path, relPath);
          else if (s.isFile()) manifest.entries.push(await copyEntry("blob", path, join(stageDir, STAGE_BLOBS, relPath), `${STAGE_BLOBS}/${relPath}`));
        }
      };
      await copyTree(blobDir, "");
    } else manifest.skipped.push("blobs: no filesystem blob store");
  } else if (!wantBlobs && (await isDir(blobDir))) manifest.skipped.push("blobs/: not in backup.include");
  if (input.blobUrl?.startsWith("s3://")) manifest.skipped.push(`blob store ${input.blobUrl} is on S3 and is not copied`);

  if (input.appDir) {
    const src = join(input.appDir, "space.yaml");
    if (await Bun.file(src).exists()) manifest.entries.push(await copyEntry("manifest", src, join(stageDir, "space.yaml"), "space.yaml"));
  }

  manifest.entries.sort((a, b) => a.path.localeCompare(b.path));
  await Bun.write(join(stageDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * A consistent copy of a live SQLite file. The source is opened read-write but
 * never written: a read-only handle cannot create the -shm file a WAL database
 * needs, so it fails on a database whose owner closed cleanly.
 */
export function snapshotSqlite(src: string, dest: string): void {
  const db = new Database(src, { readwrite: true, create: false });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("VACUUM INTO ?", [dest]);
  } finally {
    db.close();
  }
}

async function pgDump(url: string, dest: string): Promise<void> {
  if (!Bun.which("pg_dump")) throw new Error("a postgres database is declared but pg_dump is not on PATH");
  const proc = Bun.spawn(["pg_dump", "-Fc", "-f", dest, url], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`pg_dump failed: ${stderr.trim()}`);
}

async function copyEntry(kind: SnapshotEntry["kind"], src: string, dest: string, path: string): Promise<SnapshotEntry> {
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
  return { kind, path, ...(await hashFile(dest)) };
}

/**
 * gitignore-lite: `dir/` matches a directory and everything under it; a pattern
 * with a slash matches the relative path; a bare pattern matches the file name
 * anywhere. `*` never crosses a slash.
 */
export function excludeMatcher(patterns: string[]): (rel: string, isDir: boolean) => boolean {
  const dirs: string[] = [];
  const paths: Bun.Glob[] = [];
  const names: Bun.Glob[] = [];
  for (const p of patterns) {
    if (p.endsWith("/")) dirs.push(p.slice(0, -1));
    else if (p.includes("/")) paths.push(new Bun.Glob(p));
    else names.push(new Bun.Glob(p));
  }
  return (rel, isDir) => {
    for (const d of dirs) {
      if (rel === d || rel.startsWith(`${d}/`)) return true;
      if (isDir && new Bun.Glob(d).match(rel)) return true;
    }
    for (const g of paths) if (g.match(rel)) return true;
    const name = basename(rel);
    for (const g of names) if (g.match(name)) return true;
    return false;
  };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
