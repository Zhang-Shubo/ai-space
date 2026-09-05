import type { Db, Migration } from "../db.ts";
import type { BackupRecord, BackupStatus, SnapshotManifest } from "./types.ts";
import { parseKey } from "./types.ts";

/**
 * The `backups` index in space.db: one row per snapshot this workspace wrote
 * (or found in the target when rebuilding). The sidecar next to each archive
 * is the source of truth; this table is what the API and the panel read.
 */

const MIGRATIONS: Migration[] = [
  {
    id: "004-backups",
    up: (t) => `
      CREATE TABLE IF NOT EXISTS backups (
        key          TEXT PRIMARY KEY,
        app          TEXT NOT NULL,
        at           BIGINT NOT NULL,
        bytes        BIGINT NOT NULL,
        sha256       TEXT NOT NULL,
        status       TEXT NOT NULL,
        error        TEXT,
        duration_ms  BIGINT NOT NULL,
        entries      INTEGER NOT NULL,
        verified_at  BIGINT,
        verify_ok    ${t.bool},
        verify_error TEXT,
        created_at   BIGINT NOT NULL
      )`,
  },
];

type Row = {
  key: string;
  app: string;
  at: number;
  bytes: number;
  sha256: string;
  status: string;
  error: string | null;
  duration_ms: number;
  entries: number;
  verified_at: number | null;
  verify_ok: number | boolean | null;
  verify_error: string | null;
};

/** Per-app summary for the API. */
export type BackupSummary = {
  app: string;
  lastAt?: number;
  lastStatus?: BackupStatus;
  lastError?: string;
  lastOkAt?: number;
  lastOkKey?: string;
  lastOkBytes?: number;
  lastVerifiedAt?: number;
  lastVerifyOk?: boolean;
  lastVerifyError?: string;
  count: number;
};

export class BackupStore {
  private constructor(private readonly db: Db) {}

  static async open(db: Db): Promise<BackupStore> {
    await db.migrate(MIGRATIONS);
    return new BackupStore(db);
  }

  async record(r: BackupRecord): Promise<void> {
    await this.db.sql`
      INSERT INTO backups (key, app, at, bytes, sha256, status, error, duration_ms, entries, verified_at, verify_ok, verify_error, created_at)
      VALUES (${r.key}, ${r.app}, ${r.at}, ${r.bytes}, ${r.sha256}, ${r.status}, ${r.error ?? null}, ${r.durationMs}, ${r.entries},
              ${r.verifiedAt ?? null}, ${r.verifyOk ?? null}, ${r.verifyError ?? null}, ${Date.now()})
      ON CONFLICT (key) DO UPDATE SET
        at = excluded.at, bytes = excluded.bytes, sha256 = excluded.sha256, status = excluded.status, error = excluded.error,
        duration_ms = excluded.duration_ms, entries = excluded.entries,
        verified_at = COALESCE(excluded.verified_at, backups.verified_at),
        verify_ok = COALESCE(excluded.verify_ok, backups.verify_ok),
        verify_error = COALESCE(excluded.verify_error, backups.verify_error)`;
  }

  async setVerify(key: string, v: { at: number; ok: boolean; error?: string }): Promise<void> {
    await this.db.sql`UPDATE backups SET verified_at = ${v.at}, verify_ok = ${v.ok}, verify_error = ${v.error ?? null} WHERE key = ${key}`;
  }

  async remove(key: string): Promise<void> {
    await this.db.sql`DELETE FROM backups WHERE key = ${key}`;
  }

  async get(key: string): Promise<BackupRecord | undefined> {
    const rows = (await this.db.sql`SELECT * FROM backups WHERE key = ${key}`) as Row[];
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async list(app: string, limit = 100): Promise<BackupRecord[]> {
    const rows = (await this.db.sql`SELECT * FROM backups WHERE app = ${app} ORDER BY at DESC LIMIT ${limit}`) as Row[];
    return rows.map(fromRow);
  }

  async apps(): Promise<string[]> {
    const rows = (await this.db.sql`SELECT DISTINCT app FROM backups ORDER BY app`) as { app: string }[];
    return rows.map((r) => r.app);
  }

  async summary(): Promise<BackupSummary[]> {
    const rows = (await this.db.sql`SELECT * FROM backups ORDER BY app, at DESC`) as Row[];
    const out = new Map<string, BackupSummary>();
    for (const row of rows) {
      const r = fromRow(row);
      let s = out.get(r.app);
      if (!s) {
        s = { app: r.app, count: 0 };
        out.set(r.app, s);
      }
      s.count++;
      if (s.lastAt === undefined) {
        s.lastAt = r.at;
        s.lastStatus = r.status;
        if (r.error) s.lastError = r.error;
      }
      if (s.lastOkAt === undefined && r.status === "ok") {
        s.lastOkAt = r.at;
        s.lastOkKey = r.key;
        s.lastOkBytes = r.bytes;
      }
      if (s.lastVerifiedAt === undefined && r.verifiedAt !== undefined) {
        s.lastVerifiedAt = r.verifiedAt;
        s.lastVerifyOk = r.verifyOk;
        if (r.verifyError) s.lastVerifyError = r.verifyError;
      }
    }
    return [...out.values()];
  }

  /** Index a sidecar found in the target (rebuild after a lost space.db, or a snapshot another machine wrote). */
  async index(sidecar: SnapshotManifest): Promise<void> {
    if (!sidecar.key) return;
    const parsed = parseKey(sidecar.key);
    if (!parsed) return;
    await this.record({
      app: sidecar.app,
      key: sidecar.key,
      at: parsed.at.getTime(),
      bytes: sidecar.archive?.bytes ?? 0,
      sha256: sidecar.archive?.sha256 ?? "",
      status: "ok",
      durationMs: 0,
      entries: sidecar.entries.length,
      ...(sidecar.verify ? { verifiedAt: new Date(sidecar.verify.at).getTime(), verifyOk: sidecar.verify.ok, verifyError: sidecar.verify.error } : {}),
    });
  }
}

function fromRow(r: Row): BackupRecord {
  return {
    app: r.app,
    key: r.key,
    at: Number(r.at),
    bytes: Number(r.bytes),
    sha256: r.sha256,
    status: r.status as BackupStatus,
    ...(r.error ? { error: r.error } : {}),
    durationMs: Number(r.duration_ms),
    entries: Number(r.entries),
    ...(r.verified_at !== null ? { verifiedAt: Number(r.verified_at) } : {}),
    ...(r.verify_ok !== null ? { verifyOk: r.verify_ok === true || r.verify_ok === 1 } : {}),
    ...(r.verify_error ? { verifyError: r.verify_error } : {}),
  };
}
