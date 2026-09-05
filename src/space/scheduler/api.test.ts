import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes } from "./api.ts";
import { loadManifest } from "./manifest.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";

let server: ReturnType<typeof Bun.serve>;
let base = "";
let appDir = "";
let scheduler: Scheduler;
let store: Store;
// What `POST /api/apps/sync` discovers; tests add directories to it.
const discovered: string[] = [];

const auth = { authorization: "Bearer t0k", "content-type": "application/json" };

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "space-api-"));
  await writeFile(join(appDir, "space.yaml"), "name: demo\ntasks:\n  - name: echo\n    every: 1h\n    run: { command: 'echo hi' }\n");
  store = new Store(":memory:");
  scheduler = new Scheduler({ store, log: () => {} });
  scheduler.syncManifest(await loadManifest(appDir));
  discovered.push(appDir);
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createRoutes({ scheduler, store, token: "t0k", discover: async () => [...discovered] }) });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  scheduler.stop();
  server.stop(true);
});

// Test helper: response shapes are asserted inline, so the body is deliberately untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
const call = (path: string, init?: RequestInit) => fetch(base + path, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Body }));

describe("scheduler api", () => {
  test("healthz and list", async () => {
    expect((await call("/healthz")).body).toEqual({ ok: true });
    const r = await call("/api/tasks");
    expect(r.status).toBe(200);
    expect(r.body.tasks).toHaveLength(1);
    expect(r.body.tasks[0]).toMatchObject({ app: "demo", name: "echo", source: "manifest", enabled: true });
  });

  test("mutations need the bearer token", async () => {
    const r = await call("/api/tasks", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(401);
  });

  test("create, get, patch, run, runs, delete an API task", async () => {
    const created = await call("/api/tasks", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ app: "demo", name: "api-task", schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Seoul" }, target: { kind: "command", command: "true" } }),
    });
    expect(created.status).toBe(201);
    const id = created.body.task.id as string;
    expect(created.body.task.source).toBe("api");
    expect(created.body.task.state.nextRunAt).toMatch(/T00:00:00\.000Z$/);

    expect((await call(`/api/tasks/${id}`)).body.task.name).toBe("api-task");
    expect((await call("/api/tasks/nope")).status).toBe(404);

    const patched = await call(`/api/tasks/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false }) });
    expect(patched.body.task.enabled).toBe(false);
    expect(patched.body.task.state.nextRunAt).toBeUndefined();

    const run = await call(`/api/tasks/${id}/run`, { method: "POST", headers: auth });
    expect(run.status).toBe(202);
    expect(run.body.started).toBe(true);
    await scheduler.idle();
    const runs = await call(`/api/tasks/${id}/runs?limit=5`);
    expect(runs.body.runs).toHaveLength(1);
    expect(runs.body.runs[0].status).toBe("ok");

    expect((await call(`/api/tasks/${id}`, { method: "DELETE", headers: auth })).status).toBe(200);
    expect((await call(`/api/tasks/${id}`)).status).toBe(404);
  });

  test("bad create bodies are 400 with a message", async () => {
    const r = await call("/api/tasks", { method: "POST", headers: auth, body: JSON.stringify({ app: "demo", name: "x", schedule: { kind: "cron", expr: "bad" }, target: { kind: "command", command: "true" } }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid cron/);
  });

  test("workspace sync registers new directories and reports broken ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-ws-"));
    const fresh = join(root, "fresh");
    const broken = join(root, "broken");
    await mkdir(fresh);
    await mkdir(broken);
    await writeFile(join(fresh, "space.yaml"), "name: fresh\nstatus: paused\ntasks:\n  - name: tick\n    every: 1h\n    run: { command: 'echo tick' }\n");
    await writeFile(join(broken, "space.yaml"), "name: broken\nbogus: 1\n");
    discovered.push(fresh, broken);

    // Unknown to the scheduler until a workspace sync has seen its directory.
    expect((await call("/api/apps/fresh/sync", { method: "POST", headers: auth })).status).toBe(404);

    const res = await call("/api/apps/sync", { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect(res.body.synced.map((s: { app: string }) => s.app)).toEqual(["demo", "fresh"]);
    expect(res.body.skipped).toEqual([{ dir: broken, error: expect.stringContaining("bogus") }]);
    // A paused app is registered but its tasks are not scheduled.
    expect(res.body.synced[1]).toMatchObject({ app: "fresh", created: [], orphaned: [] });
    expect(scheduler.appDir("fresh")).toBe(fresh);
    expect((await call("/api/apps/fresh/sync", { method: "POST", headers: auth })).status).toBe(200);

    // Re-running is idempotent: nothing created twice, nothing gone.
    const again = await call("/api/apps/sync", { method: "POST", headers: auth });
    expect(again.body.synced.every((s: { created: string[] }) => s.created.length === 0)).toBe(true);
    expect(again.body.gone).toEqual([]);
  });

  test("workspace sync forgets an app whose directory left the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-ws-"));
    const leaving = join(root, "leaving");
    await mkdir(leaving);
    await writeFile(join(leaving, "space.yaml"), "name: leaving\ntasks:\n  - name: tick\n    every: 1h\n    run: { command: 'echo tick' }\n");
    discovered.push(leaving);
    const goneApps: string[] = [];
    const routes = createRoutes({ scheduler, store, token: "t0k", discover: async () => [...discovered], onGone: async (app) => void goneApps.push(app) });
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", routes });
    const at = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${srv.port}${path}`, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Body }));
    try {
      expect((await at("/api/apps/sync", { method: "POST", headers: auth })).body.synced.map((s: { app: string }) => s.app)).toContain("leaving");
      const tick = (await at("/api/tasks")).body.tasks.find((t: { app: string }) => t.app === "leaving");
      expect(tick.orphaned).toBe(false);

      // The directory disappears (symlink removed, checkout deleted): the next workspace sync drops it.
      discovered.splice(discovered.indexOf(leaving), 1);
      await rm(leaving, { recursive: true });
      const res = await at("/api/apps/sync", { method: "POST", headers: auth });
      expect(res.body.gone).toEqual([{ app: "leaving", created: [], updated: [], orphaned: ["tick"] }]);
      expect(goneApps).toEqual(["leaving"]);
      expect(scheduler.appDir("leaving")).toBeUndefined();
      expect((await at("/api/apps/leaving/sync", { method: "POST", headers: auth })).status).toBe(404);
      // The task stays in the store, orphaned, with its history.
      expect((await at(`/api/tasks/${tick.id}`)).body.task.orphaned).toBe(true);
      // A broken manifest is not "gone": the directory is still there.
      expect((await at("/api/apps/sync", { method: "POST", headers: auth })).body.gone).toEqual([]);
    } finally {
      srv.stop(true);
    }
  });

  test("manifest override via PATCH and re-sync through the API", async () => {
    const list = await call("/api/tasks");
    const echo = list.body.tasks.find((t: { name: string }) => t.name === "echo");
    const patched = await call(`/api/tasks/${echo.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false }) });
    expect(patched.body.task.overrides).toEqual({ enabled: false });
    expect((await call(`/api/tasks/${echo.id}`, { method: "DELETE", headers: auth })).status).toBe(400);

    await writeFile(join(appDir, "space.yaml"), "name: demo\ntasks: []\n");
    const sync = await call("/api/apps/demo/sync", { method: "POST", headers: auth });
    expect(sync.status).toBe(200);
    expect(sync.body.sync.orphaned).toEqual(["echo"]);
    expect((await call("/api/apps/unknown/sync", { method: "POST", headers: auth })).status).toBe(404);
  });
});
