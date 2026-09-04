import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotifyRoutes } from "./api.ts";
import { loadChannels } from "./channels.ts";
import { NotifyService } from "./engine.ts";
import { NotifyStore } from "./store.ts";
import { instantSleep, scriptedFetch } from "./testing.ts";

let dir: string;
let store: NotifyStore;
let svc: NotifyService;
let f: ReturnType<typeof scriptedFetch>;
let server: ReturnType<typeof Bun.serve>;
let base: string;

const TOKENS: Record<string, string> = { "sat_my-app": "my-app", sat_other: "other" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-notify-api-"));
  store = new NotifyStore(join(dir, "space.db"));
  f = scriptedFetch();
  const { channels, errors } = loadChannels({ SPACE_NOTIFY_DEFAULT: "telegram://1:tok@1", SPACE_NOTIFY_OPS: "stdout://" });
  svc = new NotifyService({ store, channels, channelErrors: errors, fetch: f.fetch, sleep: instantSleep().sleep, log: () => {}, imageDir: (app) => join(dir, app) });
  svc.syncApp("my-app", { default: "default", channels: ["default", "ops"], title: "My App", windowMs: 60_000 });
  svc.syncApp("other", { default: "ops", channels: ["ops"], windowMs: 60_000 });
  server = Bun.serve({
    port: 0,
    routes: createNotifyRoutes({ notify: svc, store, token: "op-token", appForToken: async (t) => TOKENS[t] }),
    fetch: () => new Response("nf", { status: 404 }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  server.stop(true);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /api/notify", () => {
  test("an app token identifies the app; the body's app is ignored", async () => {
    f.reply({ status: 200, body: { ok: true, result: { message_id: 3 } } });
    const res = await post("/api/notify", { app: "someone-else", text: "hi", wait: true }, "sat_my-app");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; notification: { app: string; deliveries: { channel: string; status: string }[] } };
    expect(body.notification.app).toBe("my-app");
    expect(body.notification.deliveries).toEqual([expect.objectContaining({ channel: "default", status: "sent" })]);
    expect(f.calls[0]!.body).toMatchObject({ text: "<b>[My App] hi</b>" });
  });

  test("the operator token needs an explicit app and gets 202 when not waiting", async () => {
    const res = await post("/api/notify", { app: "my-app", text: "hi", channel: "ops" }, "op-token");
    expect(res.status).toBe(202);
    const body = (await res.json()) as { notification: { id: string; deliveries: { status: string }[] } };
    expect(body.notification.deliveries[0]!.status).toBe("queued");
    await svc.idle();
    expect(store.listDeliveries(body.notification.id)[0]!.status).toBe("sent");
    expect((await post("/api/notify", { text: "hi" }, "op-token")).status).toBe(400);
  });

  test("a wrong or missing token is 401; validation errors are 400 with the reason", async () => {
    expect((await post("/api/notify", { text: "hi" }, "nope")).status).toBe(401);
    expect((await post("/api/notify", { app: "my-app", text: "hi" })).status).toBe(401);
    const bad = await post("/api/notify", { level: "loud", text: "x" }, "sat_my-app");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/level/);
    const denied = await post("/api/notify", { text: "x", channels: ["secret"] }, "sat_other");
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toMatch(/not in the app's notify.channels/);
    const notJson = await fetch(`${base}/api/notify`, { method: "POST", headers: { authorization: "Bearer sat_my-app" }, body: "nope" });
    expect(notJson.status).toBe(400);
  });
});

describe("reads and channel test", () => {
  test("channels list has no credentials; history is per app with deliveries", async () => {
    const list = (await (await fetch(`${base}/api/notify/channels`)).json()) as { channels: { name: string; kind: string; enabled: boolean }[] };
    expect(list.channels).toEqual([
      { name: "default", kind: "telegram", enabled: true },
      { name: "ops", kind: "stdout", enabled: true },
    ]);
    await post("/api/notify", { text: "a", channel: "ops", wait: true }, "sat_my-app");
    await post("/api/notify", { text: "b", channel: "ops", wait: true }, "sat_other");
    const mine = (await (await fetch(`${base}/api/notifications?app=my-app`)).json()) as { notifications: { app: string; text: string; deliveries: unknown[] }[] };
    expect(mine.notifications).toEqual([expect.objectContaining({ app: "my-app", text: "a", deliveries: [expect.objectContaining({ channel: "ops", status: "sent" })] })]);
    const all = (await (await fetch(`${base}/api/notifications`)).json()) as { notifications: { text: string }[] };
    expect(all.notifications.map((n) => n.text)).toEqual(["b", "a"]);
    expect((await fetch(`${base}/api/notifications/n_missing`)).status).toBe(404);
    expect((await fetch(`${base}/api/notifications?app=Bad!`)).status).toBe(400);
  });

  test("channel test is operator-only and reports failure as 502", async () => {
    expect((await post("/api/notify/channels/ops/test", {}, "sat_my-app")).status).toBe(401);
    const ok = await post("/api/notify/channels/ops/test", {}, "op-token");
    expect(ok.status).toBe(200);
    f.reply({ status: 401, body: { ok: false, description: "Unauthorized" } });
    const bad = await post("/api/notify/channels/default/test", {}, "op-token");
    expect(bad.status).toBe(502);
    expect(((await bad.json()) as { notification: { deliveries: { error: string }[] } }).notification.deliveries[0]!.error).toBe("telegram: 401 Unauthorized");
    expect((await post("/api/notify/channels/nope/test", {}, "op-token")).status).toBe(400);
  });
});
