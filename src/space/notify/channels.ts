import { type Channel, type ChannelKind, type ChannelLimits, NAME_PATTERN, isChannelKind } from "./types.ts";

/**
 * Channel configuration: `SPACE_NOTIFY_<NAME>=<kind>://...` lines in the
 * workspace .env, one per channel, plus `SPACE_NOTIFY_<NAME>_ENABLED=false`
 * as a kill switch. NAME is lowercased and `_` becomes `-` to form the
 * channel name (`SPACE_NOTIFY_MY_TEAM` is channel `my-team`).
 *
 * URL grammar per kind (credentials live in the URL, nothing else is needed):
 *
 *   telegram://<bot_token>@<chat_id>[,<chat_id>…][?thread=<topic_id>]
 *   discord://<webhook_id>/<webhook_token>
 *   slack://hooks.slack.com/services/<a>/<b>/<c>
 *   feishu://open.feishu.cn/open-apis/bot/v2/hook/<token>[?secret=…]
 *   dingtalk://oapi.dingtalk.com/robot/send?access_token=…[&secret=…]
 *   wecom://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…
 *   bark://<host>/<device_key>[?scheme=http]
 *   ntfy://<host>/<topic>[?token=…][&scheme=http]
 *   webhook://<host>/<path>[?token=…][&scheme=http]
 *   stdout://
 *
 * Parsing is strict: a malformed URL rejects that one channel (reported, not
 * thrown at boot) and leaves the others alone.
 */

export const ENV_PREFIX = "SPACE_NOTIFY_";
const ENABLED_SUFFIX = "_ENABLED";

export const LIMITS: Record<ChannelKind, ChannelLimits> = {
  telegram: { maxChars: 4096, splitAt: 4000, gapMs: 1000 },
  discord: { maxChars: 2000, splitAt: 1900, gapMs: 500 },
  slack: { maxChars: 40000, splitAt: 39000, gapMs: 1000 },
  feishu: { maxChars: 30000, splitAt: 29000, gapMs: 600 },
  dingtalk: { maxChars: 20000, splitAt: 19000, gapMs: 3000 },
  wecom: { maxChars: 2048, splitAt: 2000, gapMs: 3000, bytes: true },
  bark: { maxChars: 4000, splitAt: 3900, gapMs: 200 },
  ntfy: { maxChars: 4000, splitAt: 3900, gapMs: 200 },
  webhook: { maxChars: 1_000_000, splitAt: 1_000_000, gapMs: 200 },
  stdout: { maxChars: 1_000_000, splitAt: 1_000_000, gapMs: 0 },
};

export type ChannelLoad = {
  channels: Map<string, Channel>;
  /** Channels whose URL failed to parse, with the reason. */
  errors: Map<string, string>;
};

/** Read every `SPACE_NOTIFY_*` variable from an environment map. */
export function loadChannels(env: Record<string, string | undefined> = process.env): ChannelLoad {
  const channels = new Map<string, Channel>();
  const errors = new Map<string, string>();
  const disabled = new Set<string>();

  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || raw === undefined) continue;
    const rest = key.slice(ENV_PREFIX.length);
    if (rest.endsWith(ENABLED_SUFFIX)) {
      const name = envToName(rest.slice(0, -ENABLED_SUFFIX.length));
      if (name && !isTruthy(raw)) disabled.add(name);
      continue;
    }
    // Reserved settings that are not channels.
    if (rest === "TASKS") continue;
    const name = envToName(rest);
    if (!name) {
      errors.set(rest.toLowerCase(), `invalid channel name in ${key}`);
      continue;
    }
    const value = raw.trim();
    if (!value) continue;
    try {
      channels.set(name, parseChannelUrl(name, value));
    } catch (e) {
      errors.set(name, (e as Error).message);
    }
  }
  for (const name of disabled) {
    const c = channels.get(name);
    if (c) c.enabled = false;
  }
  return { channels, errors };
}

function envToName(rest: string): string | undefined {
  const name = rest.toLowerCase().replace(/_/g, "-");
  return NAME_PATTERN.test(name) ? name : undefined;
}

function isTruthy(v: string): boolean {
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/** Parse one channel URL. Throws with a message that names the problem, never echoes credentials. */
export function parseChannelUrl(name: string, url: string): Channel {
  if (!NAME_PATTERN.test(name)) throw new Error(`invalid channel name: ${name}`);
  const m = /^([a-z]+):\/\/(.*)$/s.exec(url.trim());
  if (!m) throw new Error(`channel ${name}: expected <kind>://..., got something else`);
  const kind = m[1]!;
  if (!isChannelKind(kind)) throw new Error(`channel ${name}: unknown kind "${kind}"`);
  const rest = m[2]!;
  const base: Channel = { name, kind, url: url.trim(), enabled: true, limits: { ...LIMITS[kind] } };
  const fail = (why: string): never => {
    throw new Error(`channel ${name} (${kind}): ${why}`);
  };

  switch (kind) {
    case "telegram": {
      const [main, query] = splitQuery(rest);
      const at = main.indexOf("@");
      if (at <= 0) fail("expected telegram://<bot_token>@<chat_id>");
      const token = main.slice(0, at);
      const chatIds = main
        .slice(at + 1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) fail("bot token must look like 123456:ABC-DEF");
      if (chatIds.length === 0) fail("at least one chat id is required");
      for (const id of chatIds) if (!/^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(id)) fail(`invalid chat id "${id}"`);
      const thread = query.get("thread") ?? undefined;
      if (thread !== undefined && !/^\d+$/.test(thread)) fail("thread must be a numeric topic id");
      return { ...base, telegram: { token, chatIds, ...(thread ? { thread } : {}) } };
    }
    case "discord": {
      const [main] = splitQuery(rest);
      const parts = main.replace(/^discord\.com\/api\/webhooks\//, "").split("/").filter(Boolean);
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]!)) fail("expected discord://<webhook_id>/<webhook_token>");
      return { ...base, discord: { webhook: `https://discord.com/api/webhooks/${parts[0]}/${parts[1]}` } };
    }
    case "slack": {
      const [main] = splitQuery(rest);
      if (!/^hooks\.slack\.com\/services\/[^/]+\/[^/]+\/[^/]+$/.test(main)) fail("expected slack://hooks.slack.com/services/<a>/<b>/<c>");
      return { ...base, slack: { webhook: `https://${main}` } };
    }
    case "feishu": {
      const [main, query] = splitQuery(rest);
      if (!/^[^/]+\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(main)) fail("expected feishu://<host>/open-apis/bot/v2/hook/<token>");
      const secret = query.get("secret") ?? undefined;
      return { ...base, feishu: { webhook: `https://${main}`, ...(secret ? { secret } : {}) } };
    }
    case "dingtalk": {
      const [main, query] = splitQuery(rest);
      const accessToken = query.get("access_token") ?? "";
      if (!/^[^/]+\/robot\/send$/.test(main) || !accessToken) fail("expected dingtalk://<host>/robot/send?access_token=…");
      const secret = query.get("secret") ?? undefined;
      return { ...base, dingtalk: { webhook: `https://${main}?access_token=${encodeURIComponent(accessToken)}`, ...(secret ? { secret } : {}) } };
    }
    case "wecom": {
      const [main, query] = splitQuery(rest);
      const key = query.get("key") ?? "";
      if (!/^[^/]+\/cgi-bin\/webhook\/send$/.test(main) || !key) fail("expected wecom://<host>/cgi-bin/webhook/send?key=…");
      return { ...base, wecom: { webhook: `https://${main}?key=${encodeURIComponent(key)}` } };
    }
    case "bark": {
      const [main, query] = splitQuery(rest);
      const parts = main.split("/").filter(Boolean);
      if (parts.length !== 2) fail("expected bark://<host>/<device_key>");
      return { ...base, bark: { base: `${scheme(query)}://${parts[0]}`, deviceKey: parts[1]! } };
    }
    case "ntfy": {
      const [main, query] = splitQuery(rest);
      const parts = main.split("/").filter(Boolean);
      if (parts.length !== 2) fail("expected ntfy://<host>/<topic>");
      const token = query.get("token") ?? undefined;
      return { ...base, ntfy: { base: `${scheme(query)}://${parts[0]}`, topic: parts[1]!, ...(token ? { token } : {}) } };
    }
    case "webhook": {
      const [main, query] = splitQuery(rest);
      if (!main || main.startsWith("/")) fail("expected webhook://<host>/<path>");
      const token = query.get("token") ?? undefined;
      const passthrough = new URLSearchParams(query);
      passthrough.delete("token");
      passthrough.delete("scheme");
      const qs = passthrough.toString();
      return { ...base, webhook: { endpoint: `${scheme(query)}://${main}${qs ? `?${qs}` : ""}`, ...(token ? { token } : {}) } };
    }
    case "stdout":
      return base;
  }
}

function splitQuery(rest: string): [string, URLSearchParams] {
  const q = rest.indexOf("?");
  if (q < 0) return [rest, new URLSearchParams()];
  return [rest.slice(0, q), new URLSearchParams(rest.slice(q + 1))];
}

function scheme(query: URLSearchParams): "http" | "https" {
  return query.get("scheme") === "http" ? "http" : "https";
}
