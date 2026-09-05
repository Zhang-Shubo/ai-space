import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extractArchive, hashFile } from "./archive.ts";
import { listSnapshots, readSidecar } from "./catalog.ts";
import type { BackupDeps } from "./run.ts";
import { stagingRoot } from "./run.ts";
import { MANIFEST_NAME, STAGE_BLOBS, STAGE_DATABASES, STAGE_FILES } from "./snapshot.ts";
import { SPACE_APP, type SnapshotManifest, stamp } from "./types.ts";

/**
 * Restore: fetch a snapshot, check it, unpack it into the data-dir layout.
 * `to` unpacks into any directory and stops. In place replaces the app's data
 * directory after moving the current one aside; it needs the app stopped, and
 * starting it again is the operator's step, because ai-space does not own
 * the unit.
 */

export type RestoreOptions = {
  app: string;
  /** Snapshot time as a stamp (`2026-09-05T14-30-00Z`) or ISO; default: the newest. */
  at?: string;
  /** Unpack here and stop. */
  to?: string;
  /** Replace `<workspace>/data/<app>/`. */
  inPlace?: boolean;
  /** The operator has stopped the app themselves. */
  stopped?: boolean;
  /** Stops the app's service; used in place of `stopped`. */
  stopService?: (app: string) => Promise<void>;
  now?: () => Date;
};

export type RestoreResult = {
  key: string;
  dir: string;
  files: number;
  asideDir?: string;
  manifest: SnapshotManifest;
};

/** Files inside the archive that describe the snapshot, kept under this directory on restore. */
export const SNAPSHOT_META_DIR = ".snapshot";

export async function restoreSnapshot(deps: BackupDeps, opts: RestoreOptions): Promise<RestoreResult> {
  if (!opts.to && !opts.inPlace) throw new Error("restore needs --to <dir> or --in-place");
  if (opts.to && opts.inPlace) throw new Error("restore takes either --to or --in-place, not both");
  if (opts.inPlace && opts.app === SPACE_APP) throw new Error(`the ${SPACE_APP} snapshot holds only space.db; restore it with --to and copy the file while ai-space is stopped`);
  const now = (opts.now ?? (() => new Date()))();

  const refs = await listSnapshots(deps.target, opts.app);
  if (refs.length === 0) throw new Error(`no snapshot of ${opts.app} in ${deps.target.url}`);
  const wanted = opts.at ? normalizeStamp(opts.at) : undefined;
  const ref = wanted ? refs.find((r) => stamp(r.at) === wanted) : refs[0];
  if (!ref) throw new Error(`no snapshot of ${opts.app} at ${wanted}; have ${refs.map((r) => stamp(r.at)).join(", ")}`);
  const manifest = await readSidecar(deps.target, ref.key);
  if (!manifest) throw new Error(`sidecar of ${ref.key} is missing`);

  const work = join(stagingRoot(deps.ws), "restore", opts.app);
  await rm(work, { recursive: true, force: true });
  try {
    const archivePath = join(work, "snapshot.tar.zst");
    await deps.target.get(ref.key, archivePath);
    const { sha256 } = await hashFile(archivePath);
    if (manifest.archive && manifest.archive.sha256 !== sha256) throw new Error(`archive ${ref.key} does not match its sidecar (sha256 ${sha256.slice(0, 12)}… vs ${manifest.archive.sha256.slice(0, 12)}…)`);
    const unpacked = join(work, "unpacked");
    await extractArchive(archivePath, unpacked);

    if (opts.to) {
      const files = await materialize(unpacked, opts.to);
      return { key: ref.key, dir: opts.to, files, manifest };
    }

    const dataDir = join(deps.ws.data, opts.app);
    if (!(await exists(dataDir))) throw new Error(`${dataDir} does not exist; this workspace has no app ${opts.app} (use --to for an inspection copy)`);
    if (opts.stopService) await opts.stopService(opts.app);
    else if (!opts.stopped) throw new Error("stop the app first and pass --stopped, or configure SPACE_SERVICE_STOP");
    const asideDir = `${dataDir}.pre-restore-${stamp(now)}`;
    await rename(dataDir, asideDir);
    await mkdir(dataDir, { recursive: true });
    const files = await materialize(unpacked, dataDir);
    // The generated env is not in the snapshot; keep the current one until the next sync rewrites it.
    const env = join(asideDir, "space.env");
    if (await exists(env)) await Bun.write(join(dataDir, "space.env"), Bun.file(env));
    return { key: ref.key, dir: dataDir, files, asideDir, manifest };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Map the archive layout onto a data directory: `databases/<rel>` and
 * `files/<rel>` land at `<rel>`, `blobs/<rel>` under `blobs/`, and the
 * snapshot's own files under `.snapshot/`. Returns the number of files written.
 */
export async function materialize(unpacked: string, destDir: string): Promise<number> {
  await mkdir(destDir, { recursive: true });
  let count = 0;
  const copyTree = async (from: string, to: string) => {
    if (!(await exists(from))) return;
    for (const name of await readdir(from)) {
      const src = join(from, name);
      const dest = join(to, name);
      if ((await stat(src)).isDirectory()) await copyTree(src, dest);
      else {
        await mkdir(dirname(dest), { recursive: true });
        await Bun.write(dest, Bun.file(src));
        count++;
      }
    }
  };
  await copyTree(join(unpacked, STAGE_DATABASES), destDir);
  await copyTree(join(unpacked, STAGE_FILES), destDir);
  await copyTree(join(unpacked, STAGE_BLOBS), join(destDir, STAGE_BLOBS));
  for (const name of ["space.yaml", MANIFEST_NAME]) {
    const src = join(unpacked, name);
    if (await exists(src)) {
      await mkdir(join(destDir, SNAPSHOT_META_DIR), { recursive: true });
      await Bun.write(join(destDir, SNAPSHOT_META_DIR, name), Bun.file(src));
      count++;
    }
  }
  return count;
}

/** `2026-09-05T14:30:00Z`, `2026-09-05T14:30:00.000Z` or the stamp form → the stamp form. */
export function normalizeStamp(s: string): string {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error(`not a snapshot time: ${s}`);
  return stamp(d);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
