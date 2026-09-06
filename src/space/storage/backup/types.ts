/**
 * Backup data model: what an app declares (`backup:` in space.yaml), what a
 * snapshot contains (its manifest, also stored next to the archive as a
 * sidecar), and what the `backups` index in space.db remembers.
 * See `docs/backup.md`.
 */

export const BACKUP_SOURCES = ["databases", "files", "blobs"] as const;
export type BackupSource = (typeof BACKUP_SOURCES)[number];

/** Snapshots to keep per app: the newest `daily`, the first of the newest `weekly` ISO weeks and `monthly` months. */
export type Keep = { daily: number; weekly: number; monthly: number };

export type BackupSpec = {
  enabled: boolean;
  /** Cron expression; undefined = the workspace default with a per-app minute. */
  schedule?: string;
  timezone?: string;
  keep: Keep;
  include: BackupSource[];
  /** Extra excludes for the `files` source, gitignore-style, relative to the data dir. */
  exclude: string[];
};

export const DEFAULT_KEEP: Keep = { daily: 7, weekly: 4, monthly: 6 };
export const DEFAULT_INCLUDE: BackupSource[] = ["databases", "files"];
/** Never copied by the `files` source: the blob store (its own source), caches, the generated env, SQLite side files. */
export const DEFAULT_EXCLUDES = ["blobs/", "notify/", ".snapshot/", "space.env", "*.db-wal", "*.db-shm", "*.db-journal", "*.log", "*.lock", ".DS_Store"];

export const DEFAULT_SPEC: BackupSpec = { enabled: true, keep: DEFAULT_KEEP, include: DEFAULT_INCLUDE, exclude: [] };

/** ai-space's own data (`space.db`) is backed up under this app name. Reserved: no app may use it. */
export const SPACE_APP = "space";

export const ARCHIVE_EXT = ".tar.zst";
export const SIDECAR_EXT = ".json";

export type SnapshotEntryKind = "sqlite" | "postgres" | "file" | "blob" | "manifest";

/** One file inside the archive. `path` is relative to the archive root. */
export type SnapshotEntry = {
  kind: SnapshotEntryKind;
  path: string;
  bytes: number;
  sha256: string;
};

export type VerifyInfo = { at: string; ok: boolean; error?: string };

/** `manifest.json` inside the archive and the `.json` sidecar next to it in the target. */
export type SnapshotManifest = {
  version: 1;
  app: string;
  /** ISO time the snapshot started. */
  at: string;
  /** Object key of the archive; set once the key is known. */
  key?: string;
  entries: SnapshotEntry[];
  /** Exclude patterns in force. */
  excluded: string[];
  /** Human-readable notes about what was left out and why. */
  skipped: string[];
  /** The app's S3 blob store, recorded so a restore knows where the objects live. */
  blobUrl?: string;
  archive?: { bytes: number; sha256: string };
  verify?: VerifyInfo;
};

export type BackupStatus = "ok" | "error";

/** One row of the `backups` index. */
export type BackupRecord = {
  app: string;
  key: string;
  at: number;
  bytes: number;
  sha256: string;
  status: BackupStatus;
  error?: string;
  durationMs: number;
  entries: number;
  verifiedAt?: number;
  verifyOk?: boolean;
  verifyError?: string;
};

/** `2026-09-05T14-30-00Z`: sortable, safe in object keys and file names. */
export function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

export function parseStamp(s: string): Date | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(s);
  if (!m) return undefined;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function archiveKey(app: string, at: Date): string {
  return `${app}/${stamp(at)}${ARCHIVE_EXT}`;
}

export function sidecarKey(key: string): string {
  return key.endsWith(ARCHIVE_EXT) ? `${key.slice(0, -ARCHIVE_EXT.length)}${SIDECAR_EXT}` : `${key}${SIDECAR_EXT}`;
}

/** Split an archive or sidecar key back into app and time; undefined for keys this module did not write. */
export function parseKey(key: string): { app: string; at: Date; archive: string } | undefined {
  // One segment for the app: another machine's prefix nested under this one is not ours.
  const m = /^([^/]+)\/([^/]+?)(\.tar\.zst|\.json)$/.exec(key);
  if (!m) return undefined;
  const at = parseStamp(m[2]!);
  if (!at) return undefined;
  return { app: m[1]!, at, archive: `${m[1]}/${m[2]}${ARCHIVE_EXT}` };
}
