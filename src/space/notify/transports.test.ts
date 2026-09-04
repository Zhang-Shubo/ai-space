import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { parseChannelUrl } from "./channels.ts";
import { scriptedFetch } from "./testing.ts";
import { TRANSPORTS, TransportError, type Outgoing } from "./transports.ts";
import type { Notification } from "./types.ts";

const n: Notification = { id: "n_1", app: "my-app", level: "alert", title: "Feed <stalled>", text: "No items & nothing.", url: "https://x.test/r", createdAt: 0 };
const out = (url: string, extra: Partial<Outgoing> = {}): Outgoing => ({ channel: parseChannelUrl("c", url), notification: n, appTitle: "My App", ...extra });
const noop = () => {};

describe("telegram", () => {
  test("posts HTML to every chat id with previews off and returns the message id", async () => {
    const f = scriptedFetch();
    f.reply({ status: 200, body: { ok: true, result: { message_id: 11 } } }, { status: 200, body: { ok: true, result: { message_id: 12 } } });
    const r = await TRANSPORTS.telegram(out("telegram://1:tok@-100,42?thread=9"), f.fetch, noop);
    expect(r).toEqual({ providerId: "11" });
    expect(f.calls.map((c) => c.url)).toEqual(["https://api.telegram.org/bot1:tok/sendMessage", "https://api.telegram.org/bot1:tok/sendMessage"]);
    expect(f.calls[0]!.body).toEqual({
      chat_id: "-100",
      parse_mode: "HTML",
      message_thread_id: 9,
      text: "<b>🚨 [My App] Feed &lt;stalled&gt;</b>\nNo items &amp; nothing.\nhttps://x.test/r",
      disable_web_page_preview: true,
    });
    expect(f.calls[1]!.body).toMatchObject({ chat_id: "42" });
  });

  test("429 carries retry_after; other 4xx are final; 5xx are transient", async () => {
    const f = scriptedFetch();
    f.reply({ status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } } });
    await expect(TRANSPORTS.telegram(out("telegram://1:tok@1"), f.fetch, noop)).rejects.toMatchObject({ retryAfterMs: 7000, final: false });
    f.reply({ status: 401, body: { ok: false, description: "Unauthorized" } });
    await expect(TRANSPORTS.telegram(out("telegram://1:tok@1"), f.fetch, noop)).rejects.toMatchObject({ final: true, message: "telegram: 401 Unauthorized" });
    f.reply({ status: 502, body: {} });
    await expect(TRANSPORTS.telegram(out("telegram://1:tok@1"), f.fetch, noop)).rejects.toMatchObject({ final: false });
    f.reply(new Error("ECONNRESET"));
    await expect(TRANSPORTS.telegram(out("telegram://1:tok@1"), f.fetch, noop)).rejects.toThrow(/network: ECONNRESET/);
  });

  test("an uploaded image goes as a photo with the text as caption; a failed upload degrades to text", async () => {
    const f = scriptedFetch();
    f.reply({ status: 200, body: { ok: true, result: { message_id: 5 } } });
    const image = { bytes: new Uint8Array([1, 2, 3]), type: "image/png" };
    const r = await TRANSPORTS.telegram(out("telegram://1:tok@1", { image }), f.fetch, noop);
    expect(r).toEqual({ providerId: "5" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toContain("/sendPhoto");
    expect(f.calls[0]!.body).toMatchObject({ chat_id: "1", caption: expect.stringContaining("Feed &lt;stalled&gt;"), photo: "<file photo.png 3b>" });

    const g = scriptedFetch();
    g.reply({ status: 400, body: { ok: false, description: "PHOTO_INVALID_DIMENSIONS" } }, { status: 200, body: { ok: true, result: { message_id: 6 } } });
    const r2 = await TRANSPORTS.telegram(out("telegram://1:tok@1", { image }), g.fetch, noop);
    expect(r2).toEqual({ providerId: "6", degraded: "image dropped: telegram: 400 PHOTO_INVALID_DIMENSIONS" });
    expect(g.calls[1]!.url).toContain("/sendMessage");
  });
});

describe("discord", () => {
  test("posts escaped markdown with wait=true and reads the message id", async () => {
    const f = scriptedFetch();
    f.reply({ status: 200, body: { id: "777" } });
    const r = await TRANSPORTS.discord(out("discord://1/abc"), f.fetch, noop);
    expect(r).toEqual({ providerId: "777" });
    expect(f.calls[0]!.url).toBe("https://discord.com/api/webhooks/1/abc?wait=true");
    expect(f.calls[0]!.body).toEqual({ content: "**🚨 [My App] Feed <stalled>**\nNo items & nothing.\nhttps://x.test/r" });
  });

  test("429 uses discord's fractional retry_after", async () => {
    const f = scriptedFetch();
    f.reply({ status: 429, body: { retry_after: 0.35 } });
    await expect(TRANSPORTS.discord(out("discord://1/abc"), f.fetch, noop)).rejects.toMatchObject({ retryAfterMs: 350 });
  });
});

describe("webhook family", () => {
  test("slack sends mrkdwn with a link", async () => {
    const f = scriptedFetch();
    await TRANSPORTS.slack(out("slack://hooks.slack.com/services/a/b/c"), f.fetch, noop);
    expect(f.calls[0]!.body).toEqual({ text: "*🚨 [My App] Feed &lt;stalled&gt;*\nNo items &amp; nothing.\n<https://x.test/r|https://x.test/r>" });
  });

  test("feishu signs with the secret and treats a non-zero code as final", async () => {
    const f = scriptedFetch();
    f.reply({ status: 200, body: { code: 0 } });
    await TRANSPORTS.feishu(out("feishu://open.feishu.cn/open-apis/bot/v2/hook/abc?secret=S"), f.fetch, noop);
    const body = f.calls[0]!.body as { msg_type: string; content: { text: string }; timestamp: string; sign: string };
    expect(body.msg_type).toBe("text");
    expect(body.content.text).toBe("🚨 [My App] Feed <stalled>\nNo items & nothing.\nhttps://x.test/r");
    expect(body.sign).toBe(createHmac("sha256", `${body.timestamp}\nS`).update("").digest("base64"));
    f.reply({ status: 200, body: { code: 19021, msg: "sign match fail" } });
    await expect(TRANSPORTS.feishu(out("feishu://open.feishu.cn/open-apis/bot/v2/hook/abc"), f.fetch, noop)).rejects.toMatchObject({ final: true, message: "feishu: 19021 sign match fail" });
  });

  test("dingtalk signs the query string and maps its rate-limit code to a wait", async () => {
    const f = scriptedFetch();
    f.reply({ status: 200, body: { errcode: 0 } });
    await TRANSPORTS.dingtalk(out("dingtalk://oapi.dingtalk.com/robot/send?access_token=T&secret=S"), f.fetch, noop);
    const u = new URL(f.calls[0]!.url);
    expect(u.searchParams.get("access_token")).toBe("T");
    const ts = u.searchParams.get("timestamp")!;
    expect(u.searchParams.get("sign")).toBe(createHmac("sha256", "S").update(`${ts}\nS`).digest("base64"));
    expect(f.calls[0]!.body).toMatchObject({ msgtype: "markdown", markdown: { title: "🚨 [My App] Feed <stalled>" } });
    f.reply({ status: 200, body: { errcode: 130101, errmsg: "send too fast" } });
    await expect(TRANSPORTS.dingtalk(out("dingtalk://oapi.dingtalk.com/robot/send?access_token=T"), f.fetch, noop)).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  test("wecom sends text, then an image message with md5, and drops images over 2 MB", async () => {
    const f = scriptedFetch();
    f.reply({ status: 200, body: { errcode: 0 } }, { status: 200, body: { errcode: 0 } });
    const image = { bytes: new Uint8Array([9, 9]), type: "image/png" };
    const r = await TRANSPORTS.wecom(out("wecom://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K", { image }), f.fetch, noop);
    expect(r).toEqual({});
    expect(f.calls[0]!.body).toEqual({ msgtype: "text", text: { content: "🚨 [My App] Feed <stalled>\nNo items & nothing.\nhttps://x.test/r" } });
    expect(f.calls[1]!.body).toEqual({ msgtype: "image", image: { base64: "CQk=", md5: new Bun.CryptoHasher("md5").update(image.bytes).digest("hex") } });

    const g = scriptedFetch();
    const big = { bytes: new Uint8Array(2 * 1024 * 1024 + 1), type: "image/png" };
    const r2 = await TRANSPORTS.wecom(out("wecom://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K", { image: big }), g.fetch, noop);
    expect(r2.degraded).toMatch(/2 MB/);
    expect(g.calls).toHaveLength(1);
  });

  test("bark and ntfy send title and body separately with level mapped to priority", async () => {
    const f = scriptedFetch();
    await TRANSPORTS.bark(out("bark://api.day.app/KEY"), f.fetch, noop);
    expect(f.calls[0]!.url).toBe("https://api.day.app/push");
    expect(f.calls[0]!.body).toEqual({ device_key: "KEY", title: "🚨 [My App] Feed <stalled>", body: "No items & nothing.", level: "timeSensitive", url: "https://x.test/r" });

    const g = scriptedFetch();
    g.reply({ status: 200, body: { id: "ntfy-1" } });
    const r = await TRANSPORTS.ntfy(out("ntfy://ntfy.sh/topic?token=tk"), g.fetch, noop);
    expect(r).toEqual({ providerId: "ntfy-1" });
    expect(g.calls[0]!.url).toBe("https://ntfy.sh");
    expect(g.calls[0]!.headers.authorization).toBe("Bearer tk");
    expect(g.calls[0]!.body).toEqual({ topic: "topic", title: "🚨 [My App] Feed <stalled>", message: "No items & nothing.", priority: 5, click: "https://x.test/r" });
  });

  test("generic webhook posts the notification JSON with a bearer token and honours Retry-After", async () => {
    const f = scriptedFetch();
    await TRANSPORTS.webhook(out("webhook://hooks.example/n?token=abc"), f.fetch, noop);
    expect(f.calls[0]!.url).toBe("https://hooks.example/n");
    expect(f.calls[0]!.headers.authorization).toBe("Bearer abc");
    expect(f.calls[0]!.body).toMatchObject({ id: "n_1", app: "my-app", appTitle: "My App", level: "alert", title: "Feed <stalled>", rendered: expect.stringContaining("[My App]") });
    f.reply({ status: 429, body: {}, headers: { "retry-after": "3" } });
    await expect(TRANSPORTS.webhook(out("webhook://hooks.example/n"), f.fetch, noop)).rejects.toMatchObject({ retryAfterMs: 3000 });
    f.reply({ status: 404, body: {} });
    const err = await TRANSPORTS.webhook(out("webhook://hooks.example/n"), f.fetch, noop).catch((e) => e as TransportError);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).final).toBe(true);
  });

  test("stdout logs the plain rendering", async () => {
    const lines: string[] = [];
    const f = scriptedFetch();
    await TRANSPORTS.stdout(out("stdout://"), f.fetch, (m) => lines.push(m));
    expect(lines).toEqual(["🚨 [My App] Feed <stalled>\nNo items & nothing.\nhttps://x.test/r"]);
    expect(f.calls).toHaveLength(0);
  });
});
