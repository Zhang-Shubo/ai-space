import { isAbsolute, resolve } from "node:path";
import { SQL } from "bun";
import type { Dialect } from "./types.ts";

/**
 * Database client: open by URL, know the dialect, run migrations.
 *
 * Bun's built-in `SQL` class speaks both SQLite and PostgreSQL through one
 * tagged-template interface, so this module only adds what differs: the
 * dialect tag, SQLite pragmas on open, and an append-only migration runner
 * with two type helpers for the columns the dialects spell differently.
 * There is no SQL translation; see "Portable SQL" in `docs/storage.md`.
 */

export type Db = {
  sql: SQL;
  dialect: Dialect;
  url: string;
  /** Apply migrations that have not been applied yet, in order. Returns the ids applied now. */
  migrate(migrations: Migration[]): Promise<string[]>;
  close(): Promise<void>;
};

/** Column spellings that differ between dialects, for use inside migration strings. */
export type TypeHelpers = {
  bool: string;
  true: string;
  false: string;
  json: string;
};

export type Migration =
  | { id: string; up: string | ((t: TypeHelpers) => string) }
  | { id: string; sqlite: string; postgres: string };

export const TYPES: Record<Dialect, TypeHelpers> = {
  sqlite: { bool: "INTEGER", true: "1", false: "0", json: "TEXT" },
  postgres: { bool: "BOOLEAN", true: "TRUE", false: "FALSE", json: "JSONB" },
};

export type ParsedUrl = { dialect: Dialect; path?: string };

/** Classify a database URL. SQLite paths are made absolute against cwd. */
export function parseDatabaseUrl(url: string): ParsedUrl {
  const u = url.trim();
  if (/^postgres(ql)?:\/\//i.test(u)) return { dialect: "postgres" };
  const m = /^sqlite:(?:\/\/)?(.*)$/i.exec(u);
  if (m) {
    const raw = m[1] ?? "";
    if (raw === ":memory:" || raw === "") return { dialect: "sqlite", path: ":memory:" };
    return { dialect: "sqlite", path: isAbsolute(raw) ? raw : resolve(raw) };
  }
  throw new Error(`unsupported database url: ${u}`);
}

/** Build the canonical URL for a SQLite file. */
export function sqliteUrl(path: string): string {
  return `sqlite://${resolve(path)}`;
}

export async function openDatabase(url: string): Promise<Db> {
  const parsed = parseDatabaseUrl(url);
  let sql: SQL;
  if (parsed.dialect === "sqlite") {
    sql = new SQL(parsed.path === ":memory:" ? "sqlite://:memory:" : sqliteUrl(parsed.path!));
    await sql`PRAGMA journal_mode = WAL`;
    await sql`PRAGMA synchronous = NORMAL`;
    await sql`PRAGMA busy_timeout = 5000`;
    await sql`PRAGMA foreign_keys = ON`;
  } else {
    sql = new SQL(url);
  }
  const db: Db = {
    sql,
    dialect: parsed.dialect,
    url,
    migrate: (migrations) => migrate(db, migrations),
    close: () => sql.close(),
  };
  return db;
}

const MIGRATIONS_TABLE = "_migrations";

/**
 * Append-only migrations. Each id runs at most once; the record and the DDL
 * commit together. Ids must be unique and stable; ordering is the array order.
 */
export async function migrate(db: Db, migrations: Migration[]): Promise<string[]> {
  await db.sql.unsafe(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) throw new Error(`duplicate migration id: ${m.id}`);
    seen.add(m.id);
  }
  const done = new Set((await db.sql.unsafe(`SELECT id FROM ${MIGRATIONS_TABLE}`)).map((r: { id: string }) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    const ddl = statementFor(m, db.dialect);
    await db.sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO _migrations (id, applied_at) VALUES (${m.id}, ${Date.now()})`;
    });
    applied.push(m.id);
  }
  return applied;
}

function statementFor(m: Migration, dialect: Dialect): string {
  if ("up" in m) return typeof m.up === "function" ? m.up(TYPES[dialect]) : m.up;
  return m[dialect];
}
