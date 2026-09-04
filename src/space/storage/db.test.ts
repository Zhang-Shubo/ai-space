import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, type Migration, TYPES, openDatabase, parseDatabaseUrl, sqliteUrl } from "./db.ts";

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "space-db-"));
  dirs.push(d);
  return d;
}

describe("parseDatabaseUrl", () => {
  test("classifies sqlite and postgres urls", () => {
    expect(parseDatabaseUrl("sqlite:///tmp/a.db")).toEqual({ dialect: "sqlite", path: "/tmp/a.db" });
    expect(parseDatabaseUrl("sqlite://:memory:")).toEqual({ dialect: "sqlite", path: ":memory:" });
    expect(parseDatabaseUrl("postgres://u:p@h/db")).toEqual({ dialect: "postgres" });
    expect(parseDatabaseUrl("postgresql://u:p@h/db")).toEqual({ dialect: "postgres" });
    expect(() => parseDatabaseUrl("mysql://x")).toThrow(/unsupported/);
  });

  test("relative sqlite paths resolve against cwd", () => {
    expect(parseDatabaseUrl("sqlite:data/x.db").path).toBe(join(process.cwd(), "data/x.db"));
    expect(sqliteUrl("data/x.db")).toBe(`sqlite://${join(process.cwd(), "data/x.db")}`);
  });
});

describe("openDatabase (sqlite)", () => {
  test("opens a file in WAL mode and runs queries", async () => {
    const dir = await tempDir();
    const db = await openDatabase(sqliteUrl(join(dir, "a.db")));
    dbs.push(db);
    expect(db.dialect).toBe("sqlite");
    const [{ journal_mode }] = await db.sql`PRAGMA journal_mode`;
    expect(journal_mode).toBe("wal");
    await db.sql`CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)`;
    await db.sql`INSERT INTO t (id, n) VALUES (${"a"}, ${1}) ON CONFLICT (id) DO UPDATE SET n = excluded.n`;
    await db.sql`INSERT INTO t (id, n) VALUES (${"a"}, ${2}) ON CONFLICT (id) DO UPDATE SET n = excluded.n`;
    const rows = await db.sql`SELECT n FROM t WHERE id = ${"a"}`;
    expect(rows).toEqual([{ n: 2 }]);
  });

  test("migrations apply once, in order, with dialect helpers", async () => {
    const dir = await tempDir();
    const url = sqliteUrl(join(dir, "m.db"));
    const migrations: Migration[] = [
      { id: "001-notes", up: (t) => `CREATE TABLE notes (id TEXT PRIMARY KEY, pinned ${t.bool} NOT NULL DEFAULT ${t.false}, meta ${t.json})` },
      { id: "002-index", up: "CREATE INDEX notes_pinned ON notes (pinned)" },
      { id: "003-fts", sqlite: "CREATE TABLE notes_extra (id TEXT)", postgres: "CREATE TABLE notes_extra (id TEXT, body TSVECTOR)" },
    ];
    const db = await openDatabase(url);
    expect(await db.migrate(migrations)).toEqual(["001-notes", "002-index", "003-fts"]);
    expect(await db.migrate(migrations)).toEqual([]);
    await db.close();

    const again = await openDatabase(url);
    dbs.push(again);
    expect(await again.migrate([...migrations, { id: "004-more", up: "ALTER TABLE notes ADD COLUMN body TEXT" }])).toEqual(["004-more"]);
    const cols = (await again.sql`PRAGMA table_info(notes)`).map((c: { name: string }) => c.name);
    expect(cols).toEqual(["id", "pinned", "meta", "body"]);
    const applied = (await again.sql`SELECT id FROM _migrations ORDER BY id`).map((r: { id: string }) => r.id);
    expect(applied).toEqual(["001-notes", "002-index", "003-fts", "004-more"]);
  });

  test("a failing migration leaves no record behind", async () => {
    const dir = await tempDir();
    const db = await openDatabase(sqliteUrl(join(dir, "f.db")));
    dbs.push(db);
    await expect(db.migrate([{ id: "bad", up: "CREATE TABLE (" }])).rejects.toThrow();
    expect((await db.sql`SELECT id FROM _migrations`).length).toBe(0);
    expect(() => db.migrate([{ id: "x", up: "SELECT 1" }, { id: "x", up: "SELECT 1" }])).toThrow(/duplicate/);
  });

  test("type helpers spell the dialect differences", () => {
    expect(TYPES.sqlite).toEqual({ bool: "INTEGER", true: "1", false: "0", json: "TEXT" });
    expect(TYPES.postgres).toEqual({ bool: "BOOLEAN", true: "TRUE", false: "FALSE", json: "JSONB" });
  });
});
