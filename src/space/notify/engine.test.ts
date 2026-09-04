import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChannels } from "./channels.ts";
import { CAP, CAP_WINDOW_MS, NotifyService, STALE_MS } from "./engine.ts";
import { NotifyStore } from "./store.ts";
import { instantSleep, scriptedFetch } from "./testing.ts";

let dir: string;
let store: NotifyStore;
let clock: number;
let f: ReturnType<typeof scriptedFetch>;
let sleeper: ReturnType<typeof instantSleep>;
let logs: string[];

const ENV = {
  SPACE_NOTIFY_DEFAULT: "telegram://1:tok@100",
  SPACE_NOTIFY_OPS: "discord://1/abc",
  SPACE_NOTIFY_OFF: "stdout://",
  SPACE_NOTIFY_OFF_ENABLED: "false",
  SPACE_NOTIFY_BROKEN: "telegram://x",
};

function service(env: Record<string, string> = ENV): NotifyService {
  const { channels, errors } = loadChannels(env);
  return new NotifyService({ store, channels, channelErrors: errors, fetch: f.fetch, now: () => clock, sleep: sleeper.sleep, log: (m) => logs.push(m), imageDir: (app) => join(dir, app) });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-notify-"));
  store = new NotifyStore(join(dir, "space.db"));
  clock = 1_700_000_000_000;
  f = scriptedFetch();
  sleeper = instantSleep();
  logs = [];
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const tgOk = (id = 1) => ({ status: 200, body: { ok: true, result: { message_id: id } } });

describe("send", () => {
  test("queues, delivers through the transport and records the provider id", async () => {
    const svc = service();
    f.reply(tgOk(42));
    const r = await svc.send("my-app", { level: "warn", title: "Hi", text: "there" });
    expect(r.notification.id).toMatch(/^n_/);
    expect(r.deliveries).toEqual([expect.objectContaining({ channel: "default", status: "queued" })]);
    await svc.idle();
    const d = store.listDeliveries(r.notification.id);
    expect(d[0]).toMatchObject({ status: "sent", attempts: 1, providerId: "42", sentAt: clock });
    expect(f.calls[0]!.body).toMatchObject({ chat_id: "100", text: "<b>⚠️ [my-app] Hi</b>\nthere" });
    expect(sleeper.delays).toEqual([1000]); // the channel gap
  });

  test("wait: true returns after delivery with the final status", async () => {
    const svc = service();
    f.reply(tgOk(7));
    const r = await svc.send("my-app", { text: "x", wait: true });
    expect(r.deliveries[0]).toMatchObject({ status: "sent", providerId: "7" });
  });

  test("uses the app's spec: title tag, default channel and the channel allow-list", async () => {
    const svc = service();
    svc.syncApp("my-app", { default: "ops", channels: ["ops"], title: "Trader", windowMs: 60_000 });
    f.reply({ status: 200, body: { id: "d1" } });
    const r = await svc.send("my-app", { text: "filled", wait: true });
    expect(r.deliveries).toEqual([expect.objectContaining({ channel: "ops", status: "sent", providerId: "d1" })]);
    expect(f.calls[0]!.body).toEqual({ content: "**[Trader] filled**" });
    await expect(svc.send("my-app", { text: "x", channels: ["default"] })).rejects.toThrow(/channel "default" is not in the app's notify.channels \(ops\)/);
  });

  test("unconfigured, misconfigured and disabled channels are recorded as skipped and the call succeeds", async () => {
    const svc = service();
    svc.syncApp("my-app", { default: "default", channels: ["default", "nope", "broken", "off"], windowMs: 1 });
    const r = await svc.send("my-app", { text: "x", channels: ["nope", "broken", "off"] });
    expect(r.deliveries.map((d) => [d.channel, d.status, d.lastError])).toEqual([
      ["nope", "skipped", "channel not configured"],
      ["broken", "skipped", expect.stringMatching(/^channel misconfigured: /)],
      ["off", "skipped", "channel disabled"],
    ]);
    expect(f.calls).toHaveLength(0);
    const none = service({});
    const r2 = await none.send("my-app", { text: "x" });
    expect(r2.deliveries[0]).toMatchObject({ channel: "default", status: "skipped", lastError: "channel not configured" });
  });

  test("a keyed notification inside its window is deduped, outside it is sent again", async () => {
    const svc = service();
    f.reply(tgOk(1), tgOk(2));
    const a = await svc.send("my-app", { text: "stalled", key: "feed", windowMs: 60_000, wait: true });
    const b = await svc.send("my-app", { text: "stalled", key: "feed", windowMs: 60_000, wait: true });
    expect(b.deliveries[0]).toMatchObject({ status: "deduped", lastError: `duplicate of ${a.notification.id}` });
    clock += 61_000;
    const c = await svc.send("my-app", { text: "stalled", key: "feed", windowMs: 60_000, wait: true });
    expect(c.deliveries[0]!.status).toBe("sent");
    // Another app with the same key is unaffected.
    f.reply(tgOk(3));
    expect((await svc.send("other", { text: "stalled", key: "feed", wait: true })).deliveries[0]!.status).toBe("sent");
    expect(f.calls).toHaveLength(3);
  });

  test("past the per-app cap the rest is skipped and one notice goes out per window", async () => {
    const svc = service();
    for (let i = 0; i < CAP + 3; i++) f.reply(tgOk(i));
    for (let i = 0; i < CAP; i++) await svc.send("my-app", { text: `msg ${i}` });
    await svc.idle();
    const over = await svc.send("my-app", { text: "one too many" });
    expect(over.deliveries[0]).toMatchObject({ status: "skipped", lastError: expect.stringMatching(/^rate limit/) });
    const over2 = await svc.send("my-app", { text: "and another" });
    expect(over2.deliveries[0]!.status).toBe("skipped");
    await svc.idle();
    const notices = store.listNotifications({ app: "my-app" }).filter((n) => n.key === "_rate-limit:default");
    expect(notices).toHaveLength(2);
    expect(store.listDeliveries(notices[0]!.id)[0]!.status).toBe("deduped");
    expect(store.listDeliveries(notices[1]!.id)[0]!.status).toBe("sent");
    expect(f.calls).toHaveLength(CAP + 1);
    expect(f.calls.at(-1)!.body).toMatchObject({ text: expect.stringContaining("Notifications suppressed") });
    // The window passes: sending works again.
    clock += CAP_WINDOW_MS + 1;
    f.reply(tgOk(99));
    expect((await svc.send("my-app", { text: "later", wait: true })).deliveries[0]!.status).toBe("sent");
    // Other apps were never affected.
    f.reply(tgOk(5));
    expect((await svc.send("other", { text: "hi", wait: true })).deliveries[0]!.status).toBe("sent");
  });
});

describe("delivery", () => {
  test("waits out a 429 without counting an attempt, capped at 60s", async () => {
    const svc = service();
    f.reply({ status: 429, body: { ok: false, description: "slow down", parameters: { retry_after: 90 } } }, tgOk(1));
    const r = await svc.send("my-app", { text: "x", wait: true });
    expect(r.deliveries[0]).toMatchObject({ status: "sent", attempts: 1 });
    expect(sleeper.delays).toEqual([60_000, 1000]);
    expect(logs.some((l) => /rate limited, waiting 60s/.test(l))).toBe(true);
  });

  test("retries transient errors with 1s, 3s, 10s and then records an error", async () => {
    const svc = service();
    f.reply(new Error("ECONNRESET"), { status: 502, body: {} }, new Error("ETIMEDOUT"));
    f.reply(tgOk(1));
    const ok = await svc.send("my-app", { text: "x", wait: true });
    expect(ok.deliveries[0]).toMatchObject({ status: "sent", attempts: 4 });
    expect(sleeper.delays.slice(0, 3)).toEqual([1000, 3000, 10_000]);

    f.reply(new Error("a"), new Error("b"), new Error("c"), new Error("d"));
    const bad = await svc.send("my-app", { text: "y", wait: true });
    expect(bad.deliveries[0]).toMatchObject({ status: "error", attempts: 4, lastError: "network: d" });
  });

  test("a final provider error is not retried", async () => {
    const svc = service();
    f.reply({ status: 401, body: { ok: false, description: "Unauthorized" } });
    const r = await svc.send("my-app", { text: "x", wait: true });
    expect(r.deliveries[0]).toMatchObject({ status: "error", attempts: 1, lastError: "telegram: 401 Unauthorized" });
    expect(f.calls).toHaveLength(1);
    expect(svc.channelViews().find((c) => c.name === "default")).toMatchObject({ kind: "telegram", enabled: true, lastError: "telegram: 401 Unauthorized" });
  });

  test("uploaded image bytes are parked on disk, sent as a photo, and removed afterwards", async () => {
    const svc = service();
    f.reply(tgOk(1));
    const data = Buffer.from("png-bytes").toString("base64");
    const r = await svc.send("my-app", { text: "chart", image: { data, type: "image/png" }, wait: true });
    expect(r.deliveries[0]!.status).toBe("sent");
    expect(f.calls[0]!.url).toContain("/sendPhoto");
    expect(f.calls[0]!.body).toMatchObject({ photo: "<file photo.png 9b>" });
    expect(await readdir(join(dir, "my-app"))).toEqual([]);
    await expect(svc.send("my-app", { text: "x", image: { data: "!!!", type: "image/png" } })).rejects.toThrow(/base64/);
  });

  test("queued deliveries older than an hour are skipped on start; younger ones resume", async () => {
    const svc = service();
    svc.stop(); // no workers: everything stays queued
    const old = await svc.send("my-app", { text: "old" });
    clock += STALE_MS + 1;
    const fresh = await svc.send("my-app", { text: "fresh" });
    expect(store.listDeliveries(old.notification.id)[0]!.status).toBe("queued");

    const restarted = service();
    f.reply(tgOk(1));
    restarted.start();
    await restarted.idle();
    expect(store.listDeliveries(old.notification.id)[0]).toMatchObject({ status: "skipped", lastError: "stale" });
    expect(store.listDeliveries(fresh.notification.id)[0]).toMatchObject({ status: "sent" });
    expect(logs.some((l) => /skipped 1 queued delivery older than an hour/.test(l))).toBe(true);
    expect(logs.some((l) => /channel broken ignored/.test(l))).toBe(true);
  });

  test("channels drain in order with one worker each, so a slow channel does not hold another", async () => {
    const svc = service();
    svc.syncApp("my-app", { default: "default", channels: ["default", "ops"], windowMs: 1 });
    f.reply(tgOk(1), { status: 200, body: { id: "d" } }, tgOk(2));
    await svc.send("my-app", { text: "one", channels: ["default", "ops"] });
    await svc.send("my-app", { text: "two" });
    await svc.idle();
    const sent = store.listNotifications({ app: "my-app" }).flatMap((n) => store.listDeliveries(n.id)).filter((d) => d.status === "sent");
    expect(sent).toHaveLength(3);
    expect(f.calls.filter((c) => c.url.includes("telegram")).map((c) => (c.body as { text: string }).text)).toEqual(["<b>[my-app] one</b>", "<b>[my-app] two</b>"]);
  });

  test("testChannel bypasses app rules and reports the delivery", async () => {
    const svc = service();
    f.reply({ status: 200, body: { id: "d" } });
    const r = await svc.testChannel("ops");
    expect(r.notification.app).toBe("space");
    expect(r.deliveries[0]).toMatchObject({ channel: "ops", status: "sent" });
    await expect(svc.testChannel("nope")).rejects.toThrow(/unknown channel/);
    await expect(svc.testChannel("broken")).rejects.toThrow(/bot token|expected telegram/);
  });

  test("channelViews never include urls or tokens", () => {
    const svc = service();
    const views = svc.channelViews();
    expect(views.map((v) => v.name)).toEqual(["default", "off", "ops", "broken"]);
    expect(views.find((v) => v.name === "broken")).toMatchObject({ enabled: false, error: expect.any(String) });
    expect(JSON.stringify(views)).not.toContain("tok");
    expect(JSON.stringify(views)).not.toContain("abc");
  });
});
