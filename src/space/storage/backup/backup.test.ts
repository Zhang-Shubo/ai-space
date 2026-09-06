import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { type Workspace, ensureWorkspace } from "../../workspace.ts";
import { type Db, openDatabase, sqliteUrl } from "../db.ts";
import { createBackupRoutes } from "./api.ts";
import { listSnapshots, readSidecar } from "./catalog.ts";
import { restoreSnapshot } from "./restore.ts";
import { type BackupDeps, pruneApp, runBackup, stagingRoot } from "./run.ts";
import { excludeMatcher } from "./snapshot.ts";
import { parseBackupSpec } from "./spec.ts";
import { BackupStore } from "./store.ts";
import { FileTarget, openBackupTarget, parseTargetUrl } from "./target.ts";
import { DEFAULT_SPEC, SPACE_APP, archiveKey, parseKey, sidecarKey, stamp } from "./types.ts";
import { verifyApp } from "./verify.ts";

let home: string;
let ws: Workspace;
let db: Db;
let deps: BackupDeps;
let targetDir: string;
let clock: Date;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "space-backup-"));
  ws = (await ensureWorkspace(home)).ws;
  db = await openDatabase(sqliteUrl(join(ws.data, "space.db")));
  targetDir = join(home, "bucket");
  clock = new Date("2026-09-05T03:00:00Z");
  deps = { ws, target: new FileTarget(targetDir), store: await BackupStore.open(db), now: () => clock };
});

afterEach(async () => {
  await db.close();
  await rm(home, { recursive: true, force: true });
});

/** An app data dir the way storage leaves it: a live WAL database, state files, things that must not be copied. */
async function seedApp(app: string): Promise<string> {
  const dir = join(ws.data, app);
  await mkdir(join(dir, "blobs", "img"), { recursive: true });
  await mkdir(join(dir, "notify"), { recursive: true });
  await mkdir(join(dir, "sessions"), { recursive: true });
  const live = new Database(join(dir, "main.db"), { create: true });
  live.run("PRAGMA journal_mode = WAL");
  live.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  live.run("INSERT INTO notes (body) VALUES ('one'), ('two')");
  // Left open on purpose: the app is running while the snapshot is taken, and the WAL is not checkpointed.
  await Bun.write(join(dir, "watchlist.json"), '{"a":1}');
  await Bun.write(join(dir, "sessions", "tg.session"), "binary");
  await Bun.write(join(dir, "blobs", "img", "x.png"), "png");
  await Bun.write(join(dir, "notify", "cache.png"), "png");
  await Bun.write(join(dir, "space.env"), "SPACE_APP=x\n");
  await Bun.write(join(dir, "debug.log"), "noise");
  return dir;
}

async function tree(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const p = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if ((await stat(p)).isDirectory()) out.push(...(await tree(p, r)));
    else out.push(r);
  }
  return out;
}

describe("runBackup", () => {
  test("snapshots databases and state files, skips the rest, records and uploads with a sidecar", async () => {
    const dataDir = await seedApp("keep");
    await Bun.write(join(ws.apps, "keep", "space.yaml"), "name: keep\n");
    const live = new Database(join(dataDir, "main.db"));
    live.run("INSERT INTO notes (body) VALUES ('three')"); // in the WAL, not yet in the main file

    const r = await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined), appDir: join(ws.apps, "keep"), blobUrl: "s3://media/keep/" });
    expect(r.key).toBe("keep/2026-09-05T03-00-00Z.tar.zst");
    expect(r.entries).toBe(4); // main.db, watchlist.json, sessions/tg.session, space.yaml
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.skipped).toEqual(["blobs/: not in backup.include", "blob store s3://media/keep/ is on S3 and is not copied"]);

    expect(await tree(targetDir)).toEqual(["keep/2026-09-05T03-00-00Z.json", "keep/2026-09-05T03-00-00Z.tar.zst"]);
    const sidecar = (await readSidecar(deps.target, r.key))!;
    expect(sidecar.key).toBe(r.key);
    expect(sidecar.archive).toEqual({ bytes: r.bytes, sha256: r.sha256 });
    expect(sidecar.entries.map((e) => `${e.kind}:${e.path}`)).toEqual(["sqlite:databases/main.db", "file:files/sessions/tg.session", "file:files/watchlist.json", "manifest:space.yaml"]);
    expect(sidecar.blobUrl).toBe("s3://media/keep/");

    const rows = await deps.store.list("keep");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ app: "keep", key: r.key, status: "ok", bytes: r.bytes, entries: 4 });

    // Staging is gone, the live database untouched and still open.
    expect(await readdir(stagingRoot(ws))).toEqual([]);
    expect(live.query("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 3 });
    live.close();
  });

  test("the snapshot is consistent: rows in the WAL are in the copy", async () => {
    const dataDir = await seedApp("keep");
    const live = new Database(join(dataDir, "main.db"));
    live.run("INSERT INTO notes (body) VALUES ('three')");
    const r = await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined) });
    const out = join(home, "out");
    await restoreSnapshot(deps, { app: "keep", to: out });
    const copy = new Database(join(out, "main.db"), { readonly: true });
    expect(copy.query("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 3 });
    expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    copy.close();
    live.close();
    expect((await readSidecar(deps.target, r.key))!.entries[0]!.kind).toBe("sqlite");
  });

  test("a WAL database whose owner closed cleanly (no -shm on disk) is still snapshotted", async () => {
    const dataDir = join(ws.data, "keep");
    await mkdir(dataDir, { recursive: true });
    const owner = new Database(join(dataDir, "main.db"), { create: true });
    owner.run("PRAGMA journal_mode = WAL");
    owner.run("CREATE TABLE t (x)");
    owner.close();
    for (const side of ["main.db-wal", "main.db-shm"]) await rm(join(dataDir, side), { force: true }); // what a clean shutdown leaves
    expect(await readdir(dataDir)).toEqual(["main.db"]);
    const r = await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined) });
    expect(r.skipped).toEqual([]);
    expect((await readSidecar(deps.target, r.key))!.entries[0]).toMatchObject({ kind: "sqlite", path: "databases/main.db" });
  });

  test("blobs are included on request; manifest excludes apply on top of the defaults", async () => {
    const dataDir = await seedApp("keep");
    const r = await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec({ include: ["databases", "files", "blobs"], exclude: ["sessions/"] }) });
    const sidecar = (await readSidecar(deps.target, r.key))!;
    expect(sidecar.entries.map((e) => e.path)).toEqual(["blobs/img/x.png", "databases/main.db", "files/watchlist.json"]);
    expect(sidecar.excluded).toContain("sessions/");
  });

  test("a file named .db that is not SQLite is copied as a plain file, with a note", async () => {
    const dataDir = await seedApp("keep");
    await Bun.write(join(dataDir, "export.db"), "not a database at all");
    const r = await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined) });
    expect(r.skipped.some((s) => s.startsWith("export.db: not a SQLite database"))).toBe(true);
    const sidecar = (await readSidecar(deps.target, r.key))!;
    expect(sidecar.entries.find((e) => e.path === "files/export.db")?.kind).toBe("file");
  });

  test("the space app is shallow: space.db only, never the app directories", async () => {
    await seedApp("keep");
    const r = await runBackup(deps, { app: SPACE_APP, dataDir: ws.data, spec: { ...DEFAULT_SPEC }, shallow: true });
    const sidecar = (await readSidecar(deps.target, r.key))!;
    expect(sidecar.entries.map((e) => e.path)).toEqual(["databases/space.db"]);
  });

  test("a failed run leaves an error row and no half objects", async () => {
    const dataDir = await seedApp("keep");
    const broken: BackupDeps = { ...deps, target: { ...deps.target, url: deps.target.url, kind: "file", put: async () => { throw new Error("bucket unreachable"); } } as typeof deps.target };
    await expect(runBackup(broken, { app: "keep", dataDir, spec: parseBackupSpec(undefined) })).rejects.toThrow("bucket unreachable");
    const rows = await deps.store.list("keep");
    expect(rows[0]).toMatchObject({ status: "error", error: "bucket unreachable" });
    expect(await readdir(stagingRoot(ws))).toEqual([]);
  });

  test("two runs of one app do not overlap", async () => {
    const dataDir = await seedApp("keep");
    await mkdir(stagingRoot(ws), { recursive: true });
    await Bun.write(join(stagingRoot(ws), "keep.lock"), String(process.pid));
    await expect(runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined) })).rejects.toThrow(/already running/);
    await Bun.write(join(stagingRoot(ws), "keep.lock"), "999999999"); // a dead pid is a stale lock
    await expect(runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined) })).resolves.toBeDefined();
  });
});

describe("retention in the target", () => {
  test("prune keeps by count and only touches snapshots with a sidecar", async () => {
    const dataDir = await seedApp("keep");
    const spec = parseBackupSpec({ keep: { daily: 2, weekly: 0, monthly: 0 } });
    for (let i = 0; i < 4; i++) {
      clock = new Date(Date.UTC(2026, 8, 1 + i, 3));
      await runBackup(deps, { app: "keep", dataDir, spec });
    }
    await Bun.write(join(targetDir, "keep", "stray.tar.zst"), "someone else's");
    await Bun.write(join(targetDir, "keep", "notes.txt"), "left alone");
    const refs = await listSnapshots(deps.target, "keep");
    expect(refs.map((r) => stamp(r.at))).toEqual(["2026-09-04T03-00-00Z", "2026-09-03T03-00-00Z"]);
    expect(await tree(join(targetDir, "keep"))).toEqual(["2026-09-03T03-00-00Z.json", "2026-09-03T03-00-00Z.tar.zst", "2026-09-04T03-00-00Z.json", "2026-09-04T03-00-00Z.tar.zst", "notes.txt", "stray.tar.zst"]);
    expect((await deps.store.list("keep")).map((r) => r.key)).toEqual(["keep/2026-09-04T03-00-00Z.tar.zst", "keep/2026-09-03T03-00-00Z.tar.zst"]);
    expect(await pruneApp(deps, "keep", spec.keep)).toEqual([]);
  });
});

describe("verify", () => {
  test("passes on a sound snapshot and records it in the index and the sidecar", async () => {
    const dataDir = await seedApp("keep");
    const r = await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined) });
    clock = new Date("2026-09-05T05:00:00Z");
    const v = await verifyApp(deps, "keep", { maxAgeMs: 48 * 3600_000, now: () => clock });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.checks).toContain("databases/main.db: integrity ok");
    expect((await deps.store.get(r.key))?.verifyOk).toBe(true);
    expect((await readSidecar(deps.target, r.key))?.verify).toEqual({ at: "2026-09-05T05:00:00.000Z", ok: true });
  });

  test("fails on a tampered archive, a stale snapshot and an app without one", async () => {
    const dataDir = await seedApp("keep");
    const r = await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined) });
    await Bun.write(join(targetDir, r.key), "garbage");
    clock = new Date("2026-09-09T05:00:00Z");
    const v = await verifyApp(deps, "keep", { maxAgeMs: 48 * 3600_000, now: () => clock });
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/newest snapshot is 98 h old/);
    expect(v.errors.some((e) => e.includes("sha256"))).toBe(true);
    expect((await deps.store.get(r.key))?.verifyOk).toBe(false);
    const none = await verifyApp(deps, "nothing", { maxAgeMs: 1 });
    expect(none.errors).toEqual(["no snapshot in the target"]);
  });

  test("a failed snapshot is dropped by the next prune when a good one exists", async () => {
    const dataDir = await seedApp("keep");
    const spec = parseBackupSpec({ keep: { daily: 5, weekly: 0, monthly: 0 } });
    const first = await runBackup(deps, { app: "keep", dataDir, spec });
    await Bun.write(join(targetDir, first.key), "garbage");
    await verifyApp(deps, "keep", { maxAgeMs: 48 * 3600_000, now: () => clock });
    clock = new Date("2026-09-06T03:00:00Z");
    const second = await runBackup(deps, { app: "keep", dataDir, spec });
    expect(second.pruned).toEqual([first.key]);
    expect(await readSidecar(deps.target, first.key)).toBeUndefined();
  });
});

describe("restore", () => {
  test("--to unpacks into the data-dir layout and needs nothing but the target", async () => {
    const dataDir = await seedApp("keep");
    await Bun.write(join(ws.apps, "keep", "space.yaml"), "name: keep\n");
    await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined), appDir: join(ws.apps, "keep") });
    // A fresh workspace with an empty index, as after losing the machine.
    const other = await mkdtemp(join(tmpdir(), "space-restore-"));
    const otherWs = (await ensureWorkspace(other)).ws;
    const otherDb = await openDatabase(sqliteUrl(join(otherWs.data, "space.db")));
    try {
      const fresh: BackupDeps = { ws: otherWs, target: new FileTarget(targetDir), store: await BackupStore.open(otherDb) };
      const out = join(other, "inspect");
      const r = await restoreSnapshot(fresh, { app: "keep", to: out });
      expect(r.files).toBe(5);
      expect(await tree(out)).toEqual([".snapshot/manifest.json", ".snapshot/space.yaml", "main.db", "sessions/tg.session", "watchlist.json"]);
      expect(await Bun.file(join(out, "watchlist.json")).text()).toBe('{"a":1}');
    } finally {
      await otherDb.close();
      await rm(other, { recursive: true, force: true });
    }
  });

  test("--at picks a snapshot by time, in either spelling", async () => {
    const dataDir = await seedApp("keep");
    await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined) });
    await Bun.write(join(dataDir, "watchlist.json"), '{"a":2}');
    clock = new Date("2026-09-06T03:00:00Z");
    await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined) });
    const out = join(home, "out");
    await restoreSnapshot(deps, { app: "keep", to: out, at: "2026-09-05T03:00:00Z" });
    expect(await Bun.file(join(out, "watchlist.json")).text()).toBe('{"a":1}');
    await rm(out, { recursive: true });
    await restoreSnapshot(deps, { app: "keep", to: out, at: "2026-09-06T03-00-00Z" });
    expect(await Bun.file(join(out, "watchlist.json")).text()).toBe('{"a":2}');
    await expect(restoreSnapshot(deps, { app: "keep", to: out, at: "2026-01-01T00:00:00Z" })).rejects.toThrow(/no snapshot of keep at 2026-01-01T00-00-00Z/);
  });

  test("--in-place moves the current data aside, keeps space.env, and refuses without a stop", async () => {
    const dataDir = await seedApp("keep");
    await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined) });
    await Bun.write(join(dataDir, "watchlist.json"), '{"a":"changed"}');
    await expect(restoreSnapshot(deps, { app: "keep", inPlace: true })).rejects.toThrow(/stop the app first/);
    const stopped: string[] = [];
    clock = new Date("2026-09-06T10:00:00Z");
    const r = await restoreSnapshot(deps, { app: "keep", inPlace: true, stopService: async (a) => void stopped.push(a), now: () => clock });
    expect(stopped).toEqual(["keep"]);
    expect(r.dir).toBe(dataDir);
    expect(r.asideDir).toBe(`${dataDir}.pre-restore-2026-09-06T10-00-00Z`);
    expect(await Bun.file(join(dataDir, "watchlist.json")).text()).toBe('{"a":1}');
    expect(await Bun.file(join(dataDir, "space.env")).text()).toBe("SPACE_APP=x\n");
    expect(await Bun.file(join(r.asideDir!, "watchlist.json")).text()).toBe('{"a":"changed"}');
    await expect(restoreSnapshot(deps, { app: SPACE_APP, inPlace: true, stopped: true })).rejects.toThrow(/--to/);
  });
});

describe("api", () => {
  test("overview marks apps without a fresh snapshot stale and runs a backup on POST", async () => {
    const dataDir = await seedApp("keep");
    await runBackup(deps, { app: "keep", dataDir, spec: parseBackupSpec(undefined) });
    const ran: string[] = [];
    const routes = createBackupRoutes({
      store: deps.store,
      target: deps.target,
      token: "t",
      maxAgeMs: 48 * 3600_000,
      taskFor: (app) => (app === "keep" || app === "hive" ? { id: `${app}:backup`, nextRunAt: 1, enabled: true } : undefined),
      runNow: (id) => (ran.push(id), true),
      apps: () => ["hive", "keep", "space"],
      now: () => Date.UTC(2026, 8, 8),
    });
    const call = async (path: string, method = "GET", headers: Record<string, string> = {}) => {
      const route = routes[path.replace(/\/keep\//, "/:app/").replace(/\/nothing\//, "/:app/")] as Record<string, (req: unknown) => Promise<Response>>;
      const res = await route[method]!(Object.assign(new Request(`http://x${path}`, { method, headers }), { params: { app: path.split("/")[3] ?? "" } }));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const overview = await call("/api/backups");
    expect(overview.status).toBe(200);
    const byApp = Object.fromEntries((overview.body.backups as { app: string; stale: boolean; taskId?: string; count: number }[]).map((b) => [b.app, b]));
    expect(byApp.keep).toMatchObject({ stale: true, taskId: "keep:backup", count: 1 }); // three days later
    expect(byApp.hive).toMatchObject({ stale: true, taskId: "hive:backup", count: 0 });
    expect(byApp.space).toMatchObject({ stale: true, count: 0 });

    expect((await call("/api/apps/keep/backups")).body).toMatchObject({ app: "keep", taskId: "keep:backup" });
    expect((await call("/api/apps/keep/backups", "POST")).status).toBe(401);
    expect((await call("/api/apps/keep/backups", "POST", { authorization: "Bearer t" })).status).toBe(202);
    expect(ran).toEqual(["keep:backup"]);
    expect((await call("/api/apps/nothing/backups", "POST", { authorization: "Bearer t" })).status).toBe(404);
  });
});

describe("helpers", () => {
  test("keys round-trip and foreign keys are rejected", () => {
    const at = new Date("2026-09-05T03:00:00Z");
    expect(archiveKey("keep", at)).toBe("keep/2026-09-05T03-00-00Z.tar.zst");
    expect(sidecarKey("keep/2026-09-05T03-00-00Z.tar.zst")).toBe("keep/2026-09-05T03-00-00Z.json");
    expect(parseKey("keep/2026-09-05T03-00-00Z.json")).toEqual({ app: "keep", at, archive: "keep/2026-09-05T03-00-00Z.tar.zst" });
    expect(parseKey("keep/stray.tar.zst")).toBeUndefined();
    expect(parseKey("notes.txt")).toBeUndefined();
    expect(parseKey("david/space/2026-09-05T03-00-00Z.json")).toBeUndefined(); // another machine's prefix nested under ours
  });

  test("target urls", () => {
    expect(parseTargetUrl("s3://bucket/backups")).toEqual({ kind: "s3", bucket: "bucket", prefix: "backups/" });
    expect(parseTargetUrl("s3://bucket")).toEqual({ kind: "s3", bucket: "bucket", prefix: "" });
    expect(parseTargetUrl("file:///tmp/x/")).toEqual({ kind: "file", dir: "/tmp/x" });
    expect(() => parseTargetUrl("ftp://x")).toThrow(/SPACE_BACKUP_URL/);
    expect(() => openBackupTarget("s3://b/p/")).toThrow(/SPACE_S3_ACCESS_KEY_ID/);
    expect(openBackupTarget("s3://b/p/", { accessKeyId: "a", secretAccessKey: "s" }).url).toBe("s3://b/p/");
  });

  test("exclude matcher", () => {
    const m = excludeMatcher(["blobs/", "*.log", "cache/*.tmp", "*.db-wal"]);
    expect(m("blobs", true)).toBe(true);
    expect(m("blobs/x/y", false)).toBe(true);
    expect(m("a/debug.log", false)).toBe(true);
    expect(m("cache/a.tmp", false)).toBe(true);
    expect(m("cache/deep/a.tmp", false)).toBe(false);
    expect(m("main.db-wal", false)).toBe(true);
    expect(m("main.db", false)).toBe(false);
    expect(m("watchlist.json", false)).toBe(false);
  });
});
