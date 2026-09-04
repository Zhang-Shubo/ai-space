import { parseDuration } from "../scheduler/schedule.ts";
import { DEFAULT_CHANNEL, DEFAULT_WINDOW_MS, type Image, LEVELS, MAX_IMAGE_BYTES, NAME_PATTERN, type NotificationInput, type NotifySpec, isLevel } from "./types.ts";

/**
 * Parsing of the `notify:` manifest section and of notification request bodies.
 *
 *   notify:
 *     default: ops                   # channel used when a request names none; default: default
 *     channels: [ops, trades]        # channels the app may name; default: [default]
 *     title: My App                  # tag in the first line; default: the app title
 *     window: 10m                    # default dedup window for keyed messages
 *
 * Strict, like the other sections: an invalid section rejects the whole app.
 */

export function parseNotifySpec(raw: unknown, fallback: { title?: string } = {}): NotifySpec {
  const spec: NotifySpec = { default: DEFAULT_CHANNEL, channels: [DEFAULT_CHANNEL], windowMs: DEFAULT_WINDOW_MS, ...(fallback.title ? { title: fallback.title } : {}) };
  if (raw === undefined || raw === null) return spec;
  if (!isRecord(raw)) throw new Error("notify must be a mapping");
  for (const key of Object.keys(raw)) {
    if (!["default", "channels", "title", "window"].includes(key)) throw new Error(`notify: unknown key "${key}"`);
  }
  if (raw.channels !== undefined) {
    if (!Array.isArray(raw.channels) || raw.channels.length === 0) throw new Error("notify.channels must be a non-empty list");
    spec.channels = raw.channels.map((c, i) => parseChannelName(c, `notify.channels[${i}]`));
    if (new Set(spec.channels).size !== spec.channels.length) throw new Error("notify.channels has duplicates");
  }
  if (raw.default !== undefined) {
    spec.default = parseChannelName(raw.default, "notify.default");
    if (!spec.channels.includes(spec.default)) {
      if (raw.channels === undefined) spec.channels = [spec.default];
      else throw new Error(`notify.default "${spec.default}" is not in notify.channels`);
    }
  } else {
    spec.default = spec.channels[0]!;
  }
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string" || !raw.title.trim()) throw new Error("notify.title must be a non-empty string");
    spec.title = raw.title.trim();
  }
  if (raw.window !== undefined) spec.windowMs = parseDuration(raw.window as string | number);
  return spec;
}

export function parseChannelName(v: unknown, where: string): string {
  const name = typeof v === "string" ? v.trim() : "";
  if (!NAME_PATTERN.test(name)) throw new Error(`${where}: invalid channel name`);
  return name;
}

/** Validate a `POST /api/notify` body. Throws with the field name on any problem. */
export function parseNotificationInput(body: unknown): NotificationInput {
  if (!isRecord(body)) throw new Error("body must be a JSON object");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (body.title !== undefined && typeof body.title !== "string") throw new Error("title must be a string");
  if (!text && !title) throw new Error("text is required");
  const input: NotificationInput = { text: text || title };
  if (title) input.title = title;
  if (body.level !== undefined) {
    if (!isLevel(body.level)) throw new Error(`level must be one of ${LEVELS.join(", ")}`);
    input.level = body.level;
  }
  if (body.url !== undefined) {
    if (typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) throw new Error("url must be an http(s) url");
    input.url = body.url;
  }
  if (body.image !== undefined) input.image = parseImage(body.image);
  const channels = body.channels ?? (body.channel !== undefined ? [body.channel] : undefined);
  if (channels !== undefined) {
    if (!Array.isArray(channels) || channels.length === 0) throw new Error("channels must be a non-empty list");
    input.channels = channels.map((c, i) => parseChannelName(c, `channels[${i}]`));
  }
  if (body.key !== undefined) {
    if (typeof body.key !== "string" || !body.key.trim() || body.key.length > 200) throw new Error("key must be a short string");
    input.key = body.key.trim();
  }
  if (body.window !== undefined) input.windowMs = parseDuration(body.window as string | number);
  if (body.windowMs !== undefined) {
    if (typeof body.windowMs !== "number" || body.windowMs <= 0) throw new Error("windowMs must be a positive number");
    input.windowMs = body.windowMs;
  }
  if (body.wait !== undefined) {
    if (typeof body.wait !== "boolean") throw new Error("wait must be boolean");
    input.wait = body.wait;
  }
  return input;
}

function parseImage(raw: unknown): Image {
  if (!isRecord(raw)) throw new Error("image must be an object with url, or data and type");
  if (typeof raw.url === "string") {
    if (!/^https?:\/\//.test(raw.url)) throw new Error("image.url must be an http(s) url");
    return { url: raw.url };
  }
  if (typeof raw.data !== "string" || !raw.data) throw new Error("image needs url, or data (base64) and type");
  const type = typeof raw.type === "string" ? raw.type : "image/png";
  if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) throw new Error("image.type must be image/png, image/jpeg, image/gif or image/webp");
  if (raw.data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) throw new Error("image.data exceeds 5 MB");
  return { data: raw.data, type };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
