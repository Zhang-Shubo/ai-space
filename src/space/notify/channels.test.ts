import { describe, expect, test } from "bun:test";
import { loadChannels, parseChannelUrl } from "./channels.ts";

describe("parseChannelUrl", () => {
  test("telegram: token, several chat ids, topic thread", () => {
    const c = parseChannelUrl("default", "telegram://123456:ABC-def_78@-1001234567890,42?thread=7");
    expect(c.kind).toBe("telegram");
    expect(c.telegram).toEqual({ token: "123456:ABC-def_78", chatIds: ["-1001234567890", "42"], thread: "7" });
    expect(c.limits.splitAt).toBe(4000);
    expect(c.enabled).toBe(true);
  });

  test("telegram: rejects a malformed token, a missing chat id and a bad thread", () => {
    expect(() => parseChannelUrl("a", "telegram://nope@1")).toThrow(/bot token/);
    expect(() => parseChannelUrl("a", "telegram://1:x@")).toThrow(/chat id/);
    expect(() => parseChannelUrl("a", "telegram://1:x@abc")).toThrow(/invalid chat id/);
    expect(() => parseChannelUrl("a", "telegram://1:x@1?thread=x")).toThrow(/thread/);
  });

  test("discord accepts the short and the full webhook form", () => {
    const short = parseChannelUrl("d", "discord://1234567890/abcDEF-xyz");
    const full = parseChannelUrl("d", "discord://discord.com/api/webhooks/1234567890/abcDEF-xyz");
    expect(short.discord?.webhook).toBe("https://discord.com/api/webhooks/1234567890/abcDEF-xyz");
    expect(full.discord?.webhook).toBe(short.discord?.webhook);
    expect(() => parseChannelUrl("d", "discord://abc/def")).toThrow(/webhook_id/);
  });

  test("slack, feishu, dingtalk and wecom keep their hook urls and secrets", () => {
    expect(parseChannelUrl("s", "slack://hooks.slack.com/services/T0/B0/xyz").slack).toEqual({ webhook: "https://hooks.slack.com/services/T0/B0/xyz" });
    expect(() => parseChannelUrl("s", "slack://example.com/x")).toThrow();
    expect(parseChannelUrl("f", "feishu://open.feishu.cn/open-apis/bot/v2/hook/abc-123?secret=s3").feishu).toEqual({ webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc-123", secret: "s3" });
    expect(parseChannelUrl("f", "feishu://open.feishu.cn/open-apis/bot/v2/hook/abc").feishu).toEqual({ webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
    expect(parseChannelUrl("dt", "dingtalk://oapi.dingtalk.com/robot/send?access_token=tok&secret=SEC").dingtalk).toEqual({ webhook: "https://oapi.dingtalk.com/robot/send?access_token=tok", secret: "SEC" });
    expect(() => parseChannelUrl("dt", "dingtalk://oapi.dingtalk.com/robot/send")).toThrow(/access_token/);
    expect(parseChannelUrl("w", "wecom://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1").wecom).toEqual({ webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1" });
    expect(parseChannelUrl("w", "wecom://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1").limits.bytes).toBe(true);
  });

  test("bark, ntfy and webhook default to https and accept scheme=http", () => {
    expect(parseChannelUrl("b", "bark://api.day.app/KEY").bark).toEqual({ base: "https://api.day.app", deviceKey: "KEY" });
    expect(parseChannelUrl("n", "ntfy://ntfy.sh/my-topic?token=tk").ntfy).toEqual({ base: "https://ntfy.sh", topic: "my-topic", token: "tk" });
    expect(parseChannelUrl("n", "ntfy://192.168.1.2:8080/t?scheme=http").ntfy).toEqual({ base: "http://192.168.1.2:8080", topic: "t" });
    expect(parseChannelUrl("h", "webhook://hooks.example/notify?token=abc&x=1&scheme=http").webhook).toEqual({ endpoint: "http://hooks.example/notify?x=1", token: "abc" });
    expect(() => parseChannelUrl("b", "bark://api.day.app")).toThrow();
  });

  test("stdout needs nothing; unknown kinds and bad shapes are rejected without echoing the url", () => {
    expect(parseChannelUrl("dev", "stdout://").kind).toBe("stdout");
    expect(() => parseChannelUrl("x", "pigeon://coop")).toThrow(/unknown kind "pigeon"/);
    expect(() => parseChannelUrl("x", "not a url")).toThrow(/expected <kind>/);
    expect(() => parseChannelUrl("Bad Name", "stdout://")).toThrow(/invalid channel name/);
    try {
      parseChannelUrl("t", "telegram://1:secret-token@abc");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-token");
    }
  });
});

describe("loadChannels", () => {
  test("reads SPACE_NOTIFY_* variables, maps names, applies kill switches and reports bad urls", () => {
    const { channels, errors } = loadChannels({
      SPACE_NOTIFY_DEFAULT: "telegram://1:a@1",
      SPACE_NOTIFY_MY_TEAM: "discord://1/abc",
      SPACE_NOTIFY_MY_TEAM_ENABLED: "false",
      SPACE_NOTIFY_BROKEN: "telegram://oops",
      SPACE_NOTIFY_EMPTY: "   ",
      SPACE_NOTIFY_TASKS: "default",
      SPACE_NOTIFY_OPS_ENABLED: "0",
      OTHER: "x",
    });
    expect([...channels.keys()].sort()).toEqual(["default", "my-team"]);
    expect(channels.get("my-team")?.enabled).toBe(false);
    expect(channels.get("default")?.enabled).toBe(true);
    expect([...errors.keys()]).toEqual(["broken"]);
    expect(errors.get("broken")).toMatch(/bot token|expected telegram/);
  });

  test("an empty environment yields no channels and no errors", () => {
    const { channels, errors } = loadChannels({});
    expect(channels.size).toBe(0);
    expect(errors.size).toBe(0);
  });
});
