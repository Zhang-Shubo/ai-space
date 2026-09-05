import type { BackupTarget } from "./target.ts";
import { ARCHIVE_EXT, SIDECAR_EXT, type SnapshotManifest, parseKey, sidecarKey } from "./types.ts";

/**
 * What the target holds, read from the sidecars. Works with nothing but the
 * bucket credentials, which is the point: a fresh machine can list and restore
 * before it has a space.db.
 */

export type SnapshotRef = {
  app: string;
  key: string;
  sidecar: string;
  at: Date;
  bytes: number;
};

/** Every snapshot with a sidecar, newest first. Objects this module did not write are ignored. */
export async function listSnapshots(target: BackupTarget, app?: string): Promise<SnapshotRef[]> {
  const objects = await target.list(app ? `${app}/` : "");
  const sizes = new Map(objects.filter((o) => o.key.endsWith(ARCHIVE_EXT)).map((o) => [o.key, o.size]));
  const refs: SnapshotRef[] = [];
  for (const o of objects) {
    if (!o.key.endsWith(SIDECAR_EXT)) continue;
    const parsed = parseKey(o.key);
    if (!parsed || (app && parsed.app !== app) || !sizes.has(parsed.archive)) continue;
    refs.push({ app: parsed.app, key: parsed.archive, sidecar: o.key, at: parsed.at, bytes: sizes.get(parsed.archive) ?? 0 });
  }
  return refs.sort((a, b) => b.at.getTime() - a.at.getTime() || a.app.localeCompare(b.app));
}

export async function readSidecar(target: BackupTarget, key: string): Promise<SnapshotManifest | undefined> {
  const text = await target.getText(sidecarKey(key));
  if (text === undefined) return undefined;
  const m = JSON.parse(text) as SnapshotManifest;
  if (m.version !== 1 || !m.app || !Array.isArray(m.entries)) throw new Error(`sidecar ${sidecarKey(key)} is not a snapshot manifest`);
  return m;
}
