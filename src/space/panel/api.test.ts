import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../scheduler/manifest.ts";
import { workspacePaths } from "../workspace.ts";
import { createPanelRoutes } from "./api.ts";
import { HealthProbe } from "./health.ts";
import { LayoutStore } from "./layout.ts";
import { AppRegistry } from "./registry.ts";
import { WidgetFeed } from "./widgets.ts";

let server: ReturnType<typeof Bun.serve>;
let base = "";
let home = "";
const registry = new AppRegistry();
const removed: string[] = [];

// Loopback calls the panel makes (health, widget sources) are answered here.
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/healthz")) return new Response("ok");
  if (url.endsWith("/api/widget")) return Response.json({ ok: true, items: [{ text: "First", url: "https://notes.example.com/1", time: "2026-09-04T09:00:00Z", extra: 1 }] });
  if (url.endsWith("/api/broken")) return Response.json({ ok: false, error: "db locked" });
  if (url.endsWith("/board?theme=dark")) return new Response("<html>board dark</html>", { headers: { "content-type": "text/html" } });
  return new Response("<html><head><meta name=\"theme-color\" content=\"#123456\"></head></html>", { headers: { "content-type": "text/html" } });
}) as typeof fetch;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "space-panel-"));
  const ws = workspacePaths(home);
  await mkdir(join(ws.apps, "notes", "agents"), { recursive: true });
  await writeFile(
    join(ws.apps, "notes", "space.yaml"),
    `spec: 1
name: notes
title: Notes
description: Personal notes.
icon: icon.svg
url: https://notes.example.com
service: { command: bun src/index.ts, port: 8712, health: /healthz }
agents:
  - { name: librarian, title: Librarian, prompt: agents/librarian.md, tools: [Read] }
widgets:
  - { name: recent, title: Notes · Recent, source: /api/widget, link: /#recent, size: 2x1 }
  - { name: broken, source: /api/broken }
  - { name: board, kind: embed, source: /board }
`,
  );
  await writeFile(join(ws.apps, "notes", "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await writeFile(join(ws.apps, "notes", "agents", "librarian.md"), "You are the librarian.");
  await mkdir(join(ws.apps, "notes", ".git"), { recursive: true });
  await mkdir(join(ws.apps, "docs"), { recursive: true });
  await writeFile(join(ws.apps, "docs", "space.yaml"), "name: docs\ntitle: Docs\nicon: '📚'\nurl: https://docs.example.com\nwidgets:\n  - { name: w, source: /api/widget }\n");
  await mkdir(join(ws.apps, "old"), { recursive: true });
  await writeFile(join(ws.apps, "old", "space.yaml"), "name: old\nstatus: archived\n");
  // A service with no page: a row under Services, no tile.
  await mkdir(join(ws.apps, "feed", ".git"), { recursive: true });
  await writeFile(join(ws.apps, "feed", "space.yaml"), "name: feed\ntitle: Feed\nicon: '📡'\nservice: { command: bun src/server.ts, port: 8713, health: /healthz }\n");
  for (const n of ["notes", "docs", "old", "feed"]) await registry.set(await loadManifest(join(ws.apps, n)));

  const db = new Database(":memory:");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: createPanelRoutes({
      ws,
      registry,
      layout: new LayoutStore(db),
      widgets: new WidgetFeed(registry, { fetch: fakeFetch }),
      health: new HealthProbe({ fetch: fakeFetch }),
      onCreate: async (dir) => {
        await registry.set(await loadManifest(dir));
      },
      onRemove: async (app) => {
        removed.push(app);
      },
      resolveLink: async (link) => ({ name: "resolved-app", title: "Resolved", icon: "🔗", description: `from ${link}`, url: "" }),
      fetch: fakeFetch,
    }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
const call = (path: string, init?: RequestInit) => fetch(base + path, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Body }));
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("panel api", () => {
  test("lists visible apps with health, agents and widgets; archived apps stay out", async () => {
    const r = await call("/api/apps");
    expect(r.status).toBe(200);
    expect(r.body.apps.map((a: Body) => a.name)).toEqual(["docs", "notes"]);
    const notes = r.body.apps[1];
    expect(notes).toMatchObject({ title: "Notes", icon: "/api/apps/notes/icon", url: "https://notes.example.com", manifestOnly: false, hidden: false, service: { port: 8712, health: "ok" } });
    expect(notes.agents[0]).toMatchObject({ id: "notes/librarian", title: "Librarian", avatar: "/api/apps/notes/icon" });
    expect(notes.widgets[0]).toMatchObject({ id: "notes/recent", link: "https://notes.example.com/#recent", size: "2x1" });
    expect(r.body.apps[0]).toMatchObject({ name: "docs", icon: "📚", manifestOnly: true });
    expect(JSON.stringify(r.body)).not.toContain("8712/api");
    expect((await call("/api/apps?all=1")).body.apps.map((a: Body) => a.name)).toEqual(["docs", "feed", "notes", "old"]);
  });

  test("apps without a url have no tile; every service is listed with its health", async () => {
    expect((await call("/api/apps/feed")).body.app).toMatchObject({ name: "feed", hidden: false, service: { port: 8713, health: "ok" } });
    expect((await call("/api/apps/feed")).body.app).not.toHaveProperty("url");
    const r = await call("/api/services");
    expect(r.status).toBe(200);
    expect(r.body.services).toEqual([
      { app: "feed", title: "Feed", icon: "📡", port: 8713, health: "ok", status: "active", hidden: false },
      { app: "notes", title: "Notes", icon: "/api/apps/notes/icon", port: 8712, health: "ok", status: "active", hidden: false },
    ]);
  });

  test("serves icons and avatars from the app directory only", async () => {
    const icon = await fetch(`${base}/api/apps/notes/icon`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("svg");
    expect((await fetch(`${base}/api/agents/notes/librarian/avatar`)).status).toBe(200);
    expect((await call("/api/apps/docs/icon")).status).toBe(404);
    expect((await call("/api/apps/nope/icon")).status).toBe(404);
  });

  test("layout: order and hidden set are stored and applied", async () => {
    const put = await call("/api/panel/layout", jsonInit("PUT", { order: { apps: ["notes", "docs"] }, hidden: ["docs"] }));
    expect(put.body.layout).toEqual({ order: { apps: ["notes", "docs"], agents: [], widgets: [] }, hidden: ["docs"] });
    expect((await call("/api/apps")).body.apps.map((a: Body) => a.name)).toEqual(["notes"]);
    expect((await call("/api/apps?all=1")).body.apps.map((a: Body) => a.name)).toEqual(["notes", "docs", "feed", "old"]);
    const unhide = await call("/api/apps/docs", jsonInit("PATCH", { hidden: false }));
    expect(unhide.body.app.hidden).toBe(false);
    expect((await call("/api/apps/docs", jsonInit("PATCH", { hidden: "yes" }))).status).toBe(400);
    expect((await call("/api/panel/layout", jsonInit("PUT", { order: { apps: "x" } }))).status).toBe(400);
  });

  test("widgets: cached payloads, honest errors, embed proxied with the theme", async () => {
    const r = await call("/api/widgets");
    expect(r.body.widgets.map((w: Body) => w.id)).toEqual(["docs/w", "notes/board", "notes/broken", "notes/recent"]);
    const byId = Object.fromEntries(r.body.widgets.map((w: Body) => [w.id, w]));
    expect(byId["notes/recent"]).toMatchObject({ ok: true, items: [{ text: "First", url: "https://notes.example.com/1", time: "2026-09-04T09:00:00Z" }], link: "https://notes.example.com/#recent" });
    expect(byId["notes/recent"].items[0]).not.toHaveProperty("extra");
    expect(byId["notes/broken"]).toMatchObject({ ok: false, error: "db locked" });
    expect(byId["docs/w"]).toMatchObject({ ok: false, error: expect.stringContaining("no service") });
    expect(byId["notes/board"]).toMatchObject({ kind: "embed", ok: true });
    const embed = await fetch(`${base}/api/widgets/notes/board/embed?theme=dark`);
    expect(await embed.text()).toBe("<html>board dark</html>");
    expect((await call("/api/widgets/notes/recent/embed")).status).toBe(404);
  });

  test("appcolor reads the theme-color meta and caches it", async () => {
    expect((await call("/api/panel/appcolor?app=notes")).body).toEqual({ ok: true, color: "#123456" });
    expect((await call("/api/panel/appcolor?app=old")).status).toBe(404);
  });

  test("creates a manifest-only app from a link or fields, deletes only those", async () => {
    const fromLink = await call("/api/apps", jsonInit("POST", { link: "https://example.com/tool" }));
    expect(fromLink.status).toBe(201);
    expect(fromLink.body.app).toMatchObject({ name: "resolved-app", title: "Resolved", icon: "🔗", url: "https://example.com/tool", manifestOnly: true });
    expect(await Bun.file(join(home, "apps", "resolved-app", "space.yaml")).text()).toContain('url: "https://example.com/tool"');
    expect((await call("/api/apps", jsonInit("POST", { link: "https://example.com/tool" }))).status).toBe(409);

    const byHand = await call("/api/apps", jsonInit("POST", { name: "Hand-Made", title: "Hand", url: "https://h.example.com" }));
    expect(byHand.status).toBe(201);
    expect(byHand.body.app.name).toBe("hand-made");
    expect((await call("/api/apps", jsonInit("POST", { name: "bad name" }))).status).toBe(400);
    expect((await call("/api/apps", jsonInit("POST", { name: "x", icon: "icon.svg" }))).status).toBe(400);

    expect((await call("/api/apps/notes", { method: "DELETE" })).status).toBe(409);
    expect((await call("/api/apps/hand-made", { method: "DELETE" })).body).toEqual({ ok: true });
    expect(removed).toEqual(["hand-made"]);
    expect(await Bun.file(join(home, "apps", "hand-made", "space.yaml")).exists()).toBe(false);
    expect((await call("/api/apps/hand-made")).status).toBe(404);
  });
});
