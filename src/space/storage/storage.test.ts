import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ensureWorkspace, type Workspace } from "../workspace.ts";
import { createStorageRoutes } from "./api.ts";
import { type Db, openDatabase, sqliteUrl } from "./db.ts";
import { type S3Target, StorageService } from "./storage.ts";

let home: string;
let ws: Workspace;
let db: Db;
let storage: StorageService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "space-storage-"));
  ws = (await ensureWorkspace(home)).ws;
  db = await openDatabase(sqliteUrl(join(ws.data, "space.db")));
  storage = await StorageService.open({ ws, db, log: () => {} });
});

afterEach(async () => {
  await db.close();
  await rm(home, { recursive: true, force: true });
});

async function envLines(app: string): Promise<Record<string, string>> {
  const text = await Bun.file(storage.envFile(app)).text();
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("StorageService.syncApp", () => {
  test("provisions sqlite files and writes space.env", async () => {
    const r = await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }, { name: "cache", backend: "sqlite" }] });
    const dir = join(ws.data, "my-app");
    expect(r.created).toEqual([dir, join(dir, "main.db"), join(dir, "cache.db")]);
    expect(r.orphaned).toEqual([]);
    expect(r.databases.map((d) => d.name)).toEqual(["cache", "main"]);

    const env = await envLines("my-app");
    expect(env).toEqual({
      SPACE_APP: "my-app",
      SPACE_APP_DATA_DIR: dir,
      DATABASE_URL: `sqlite://${join(dir, "main.db")}`,
      DATABASE_URL_CACHE: `sqlite://${join(dir, "cache.db")}`,
    });
    expect((await stat(storage.envFile("my-app"))).mode & 0o777).toBe(0o600);
    // The files are real SQLite databases an app can open right away.
    const d = new Database(join(dir, "main.db"));
    expect(d.query("PRAGMA schema_version").get()).toBeDefined();
    d.close();
  });

  test("is idempotent and leaves existing data alone", async () => {
    const spec = { databases: [{ name: "main", backend: "sqlite" as const }] };
    await storage.syncApp("my-app", spec);
    const path = join(ws.data, "my-app", "main.db");
    const d = new Database(path);
    d.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
    d.close();

    const r = await storage.syncApp("my-app", spec);
    expect(r.created).toEqual([]);
    const again = new Database(path, { readonly: true });
    expect(again.query("SELECT count(*) AS c FROM t").get()).toEqual({ c: 1 });
    again.close();
  });

  test("a pre-existing file at the provisioned path is adopted, not replaced", async () => {
    const dir = join(ws.data, "legacy");
    const path = join(dir, "news.db");
    await Bun.write(join(dir, ".keep"), "");
    const d = new Database(path, { create: true });
    d.exec("CREATE TABLE news (id TEXT); INSERT INTO news VALUES ('a')");
    d.close();

    const r = await storage.syncApp("legacy", { databases: [{ name: "news", backend: "sqlite" }] });
    expect(r.created).toEqual([]);
    expect((await envLines("legacy")).DATABASE_URL_NEWS).toBe(`sqlite://${path}`);
    const again = new Database(path, { readonly: true });
    expect(again.query("SELECT count(*) AS c FROM news").get()).toEqual({ c: 1 });
    again.close();
  });

  test("a database that leaves the manifest is orphaned, kept, and dropped from space.env", async () => {
    await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }, { name: "old", backend: "sqlite" }] });
    const r = await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }] });
    expect(r.orphaned).toEqual(["old"]);
    expect(r.databases.find((d) => d.name === "old")?.orphaned).toBe(true);
    expect(await readdir(join(ws.data, "my-app"))).toContain("old.db");
    expect(Object.keys(await envLines("my-app"))).not.toContain("DATABASE_URL_OLD");

    // Declaring it again brings it back without touching the file.
    const back = await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }, { name: "old", backend: "sqlite" }] });
    expect(back.created).toEqual([]);
    expect(back.databases.find((d) => d.name === "old")?.orphaned).toBe(false);
  });

  test("refuses to switch backends by sync", async () => {
    await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }] });
    await expect(storage.syncApp("my-app", { databases: [{ name: "main", backend: "postgres" }] })).rejects.toThrow(/not supported/);
  });

  test("postgres without an admin url fails clearly", async () => {
    await expect(storage.syncApp("my-app", { databases: [{ name: "main", backend: "postgres" }] })).rejects.toThrow(/SPACE_PG_ADMIN_URL/);
  });

  test("an app without storage still gets a data dir and a minimal space.env", async () => {
    const r = await storage.syncApp("plain", { databases: [] });
    expect(r.created).toEqual([join(ws.data, "plain")]);
    expect(await envLines("plain")).toEqual({ SPACE_APP: "plain", SPACE_APP_DATA_DIR: join(ws.data, "plain") });
  });
});

describe("StorageService.syncApp blobs", () => {
  const s3 = { accessKeyId: "AK", secretAccessKey: "SK", endpoint: "https://s3.example", region: "auto", bucket: "default-bucket" };

  async function withS3(probe?: (t: S3Target) => Promise<void>) {
    return StorageService.open({ ws, db, s3, probeS3: probe ?? (async () => {}), log: () => {} });
  }

  test("file backend creates the directory and hands over a file url", async () => {
    const r = await storage.syncApp("my-app", { databases: [], blobs: { backend: "file" } });
    const dir = join(ws.data, "my-app", "blobs");
    expect(r.created).toEqual([join(ws.data, "my-app"), dir]);
    expect(r.blobs).toMatchObject({ app: "my-app", backend: "file", url: `file://${dir}`, orphaned: false });
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(await envLines("my-app")).toEqual({ SPACE_APP: "my-app", SPACE_APP_DATA_DIR: join(ws.data, "my-app"), BLOB_URL: `file://${dir}` });
    // Idempotent.
    expect((await storage.syncApp("my-app", { databases: [], blobs: { backend: "file" } })).created).toEqual([]);
  });

  test("s3 backend probes the bucket once and writes BLOB_URL plus S3_* credentials", async () => {
    const probes: S3Target[] = [];
    const svc = await withS3(async (t) => {
      probes.push(t);
    });
    const r = await svc.syncApp("my-app", { databases: [], blobs: { backend: "s3" } });
    expect(r.blobs).toMatchObject({ backend: "s3", url: "s3://default-bucket/my-app/" });
    expect(probes).toEqual([{ ...s3, bucket: "default-bucket", prefix: "my-app/" }]);
    expect(await envLines("my-app")).toEqual({
      SPACE_APP: "my-app",
      SPACE_APP_DATA_DIR: join(ws.data, "my-app"),
      BLOB_URL: "s3://default-bucket/my-app/",
      S3_ENDPOINT: "https://s3.example",
      S3_REGION: "auto",
      S3_BUCKET: "default-bucket",
      S3_ACCESS_KEY_ID: "AK",
      S3_SECRET_ACCESS_KEY: "SK",
    });

    // A re-sync with the same declaration does not touch the network.
    await svc.syncApp("my-app", { databases: [], blobs: { backend: "s3" } });
    expect(probes.length).toBe(1);

    // A different bucket or prefix is probed again and recorded; data is not moved.
    const moved = await svc.syncApp("my-app", { databases: [], blobs: { backend: "s3", bucket: "books", prefix: "" } });
    expect(moved.blobs?.url).toBe("s3://books/");
    expect(probes.length).toBe(2);
    expect((await envLines("my-app")).S3_BUCKET).toBe("books");
    expect((await envLines("my-app")).BLOB_URL).toBe("s3://books/");
  });

  test("an unreachable bucket rejects the sync before anything is recorded", async () => {
    const svc = await withS3(async () => {
      throw new Error("403 Forbidden");
    });
    await expect(svc.syncApp("my-app", { databases: [], blobs: { backend: "s3" } })).rejects.toThrow(/not reachable.*403/);
    expect(await svc.blobStore("my-app")).toBeUndefined();
  });

  test("s3 without credentials or without a bucket fails clearly", async () => {
    await expect(storage.syncApp("my-app", { databases: [], blobs: { backend: "s3" } })).rejects.toThrow(/SPACE_S3_ACCESS_KEY_ID/);
    const noBucket = await StorageService.open({ ws, db, s3: { accessKeyId: "a", secretAccessKey: "b" }, probeS3: async () => {}, log: () => {} });
    await expect(noBucket.syncApp("my-app", { databases: [], blobs: { backend: "s3" } })).rejects.toThrow(/SPACE_S3_BUCKET/);
    expect((await noBucket.syncApp("my-app", { databases: [], blobs: { backend: "s3", bucket: "named" } })).blobs?.url).toBe("s3://named/my-app/");
  });

  test("refuses to switch blob backends by sync", async () => {
    const svc = await withS3();
    await svc.syncApp("my-app", { databases: [], blobs: { backend: "file" } });
    await expect(svc.syncApp("my-app", { databases: [], blobs: { backend: "s3" } })).rejects.toThrow(/not supported/);
  });

  test("a store that leaves the manifest is orphaned, kept, and dropped from space.env", async () => {
    await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }], blobs: { backend: "file" } });
    const r = await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }] });
    expect(r.orphaned).toEqual(["blobs"]);
    expect(r.blobs?.orphaned).toBe(true);
    expect(await readdir(join(ws.data, "my-app"))).toContain("blobs");
    expect(Object.keys(await envLines("my-app"))).toEqual(["SPACE_APP", "SPACE_APP_DATA_DIR", "DATABASE_URL"]);

    const back = await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }], blobs: { backend: "file" } });
    expect(back.created).toEqual([]);
    expect(back.blobs?.orphaned).toBe(false);
    expect((await envLines("my-app")).BLOB_URL).toBe(`file://${join(ws.data, "my-app", "blobs")}`);
  });

  test("describe reports the store without credentials", async () => {
    const svc = await withS3();
    await svc.syncApp("my-app", { databases: [], blobs: { backend: "s3", prefix: "media" } });
    const d = await svc.describe("my-app");
    expect(d.blobs).toEqual(expect.objectContaining({ backend: "s3", orphaned: false, env: "BLOB_URL", bucket: "default-bucket", prefix: "media/" }));
    expect(JSON.stringify(d)).not.toContain("SK");
    expect(JSON.stringify(d)).not.toContain("AK");
    expect(await svc.listApps()).toEqual(["my-app"]);
    expect((await svc.envFor("my-app")).S3_SECRET_ACCESS_KEY).toBe("SK");
  });
});

describe("StorageService.addDatabase", () => {
  test("api databases survive a manifest re-sync", async () => {
    await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }] });
    const d = await storage.addDatabase("my-app", "scratch", "sqlite");
    expect(d.source).toBe("api");
    expect((await envLines("my-app")).DATABASE_URL_SCRATCH).toBe(`sqlite://${join(ws.data, "my-app", "scratch.db")}`);

    const r = await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }] });
    expect(r.orphaned).toEqual([]);
    expect((await storage.list("my-app")).map((x) => [x.name, x.source, x.orphaned])).toEqual([
      ["main", "manifest", false],
      ["scratch", "api", false],
    ]);
  });

  test("is idempotent and validates names", async () => {
    await storage.addDatabase("my-app", "scratch", "sqlite");
    await storage.addDatabase("my-app", "scratch", "sqlite");
    expect((await storage.list("my-app")).length).toBe(1);
    await expect(storage.addDatabase("my-app", "../etc", "sqlite")).rejects.toThrow(/invalid database name/);
    await expect(storage.addDatabase("my-app", "scratch", "postgres")).rejects.toThrow(/already exists/);
  });
});

describe("describe / envFor", () => {
  test("describe shows paths but never urls with secrets", async () => {
    await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }] });
    const d = await storage.describe("my-app");
    expect(d.app).toBe("my-app");
    expect(d.envFile).toBe(join(ws.data, "my-app", "space.env"));
    expect(d.databases).toEqual([
      expect.objectContaining({ name: "main", backend: "sqlite", source: "manifest", orphaned: false, env: "DATABASE_URL", path: join(ws.data, "my-app", "main.db") }),
    ]);
    expect(JSON.stringify(d)).not.toContain("url");
    expect(await storage.envFor("my-app")).toEqual({
      SPACE_APP: "my-app",
      SPACE_APP_DATA_DIR: join(ws.data, "my-app"),
      DATABASE_URL: `sqlite://${join(ws.data, "my-app", "main.db")}`,
    });
    expect(await storage.envFor("unknown")).toEqual({ SPACE_APP: "unknown", SPACE_APP_DATA_DIR: join(ws.data, "unknown") });
  });
});

describe("storage routes", () => {
  type Body = any;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  beforeEach(() => {
    server = Bun.serve({ port: 0, routes: createStorageRoutes({ storage, token: "secret" }), fetch: () => new Response("nf", { status: 404 }) });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterEach(() => server.stop(true));

  test("GET storage and POST databases", async () => {
    await storage.syncApp("my-app", { databases: [{ name: "main", backend: "sqlite" }] });
    const got: Body = await (await fetch(`${base}/api/apps/my-app/storage`)).json();
    expect(got.ok).toBe(true);
    expect(got.databases.map((d: Body) => d.name)).toEqual(["main"]);

    const denied = await fetch(`${base}/api/apps/my-app/databases`, { method: "POST", body: JSON.stringify({ name: "x" }) });
    expect(denied.status).toBe(401);

    const res = await fetch(`${base}/api/apps/my-app/databases`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ name: "scratch" }),
    });
    expect(res.status).toBe(201);
    const created: Body = await res.json();
    expect(created.database).toEqual({ name: "scratch", backend: "sqlite", source: "api", env: "DATABASE_URL_SCRATCH" });

    const bad = await fetch(`${base}/api/apps/my-app/databases`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ name: "scratch", backend: "mysql" }),
    });
    expect(bad.status).toBe(400);
  });
});
