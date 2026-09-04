/**
 * Notify data model.
 *
 * A channel is where messages go (operator-owned, configured once in the
 * workspace .env). A notification is what an app sent. A delivery is one
 * notification on one channel, with its attempts and result. Everything is
 * plain JSON so it round-trips through SQLite and the HTTP API unchanged.
 */

export const CHANNEL_KINDS = ["telegram", "discord", "slack", "feishu", "dingtalk", "wecom", "bark", "ntfy", "webhook", "stdout"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const LEVELS = ["info", "success", "warn", "alert", "report"] as const;
export type Level = (typeof LEVELS)[number];

/** Leading emoji per level; `info` has none. Matches the convention apps already use by hand. */
export const LEVEL_EMOJI: Record<Level, string> = {
  alert: "🚨",
  warn: "⚠️",
  success: "✅",
  report: "📊",
  info: "",
};

/** Channel and app names: lowercase, kebab-case. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const APP_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export const DEFAULT_CHANNEL = "default";
export const DEFAULT_WINDOW_MS = 10 * 60_000;
/** Largest image payload accepted, before base64 decoding. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Per-kind limits. `maxChars` is the provider's hard limit; `splitAt` is where the renderer cuts. */
export type ChannelLimits = {
  maxChars: number;
  splitAt: number;
  /** Minimum gap between two sends on the channel. */
  gapMs: number;
  /** Measure text in UTF-8 bytes instead of characters (WeCom). */
  bytes?: boolean;
};

export type Channel = {
  name: string;
  kind: ChannelKind;
  /** The configured URL, credentials included. Never leaves the process. */
  url: string;
  enabled: boolean;
  limits: ChannelLimits;
  /** Kind-specific parts parsed from the URL. */
  telegram?: { token: string; chatIds: string[]; thread?: string };
  discord?: { webhook: string };
  slack?: { webhook: string };
  feishu?: { webhook: string; secret?: string };
  dingtalk?: { webhook: string; secret?: string };
  wecom?: { webhook: string };
  bark?: { base: string; deviceKey: string };
  ntfy?: { base: string; topic: string; token?: string };
  webhook?: { endpoint: string; token?: string };
};

/** What the public API shows about a channel: no URL, no credentials. */
export type ChannelView = {
  name: string;
  /** Absent for a channel whose URL failed to parse. */
  kind?: ChannelKind;
  enabled: boolean;
  error?: string;
  lastSentAt?: string;
  lastError?: string;
};

export type Image = { url: string } | { data: string; type: string };

/** What an app hands over. `app` comes from the caller's identity, not the body. */
export type NotificationInput = {
  level?: Level;
  title?: string;
  text: string;
  url?: string;
  image?: Image;
  channels?: string[];
  key?: string;
  /** Dedup window in milliseconds; the API accepts durations like `10m`. */
  windowMs?: number;
  wait?: boolean;
};

export type Notification = {
  id: string;
  app: string;
  level: Level;
  title?: string;
  text: string;
  url?: string;
  key?: string;
  /** Remote image, passed through to channels that render links. */
  imageUrl?: string;
  /** Local file holding uploaded image bytes; removed once every delivery is final. */
  imagePath?: string;
  imageType?: string;
  createdAt: number;
};

export type DeliveryStatus = "queued" | "sent" | "error" | "skipped" | "deduped";

export type Delivery = {
  id: number;
  notificationId: string;
  channel: string;
  status: DeliveryStatus;
  attempts: number;
  /** Last provider error, or the reason for `skipped`. Kept verbatim. */
  lastError?: string;
  /** The chat app's own message id when it returns one. */
  providerId?: string;
  sentAt?: number;
  updatedAt: number;
};

export const FINAL_STATUSES: readonly DeliveryStatus[] = ["sent", "error", "skipped", "deduped"];

/** The `notify:` section of an app manifest. */
export type NotifySpec = {
  /** Channel used when a request names none. */
  default: string;
  /** Channels the app may name. Always contains `default`. */
  channels: string[];
  /** Tag in the first line of every message; falls back to the app title, then the name. */
  title?: string;
  windowMs: number;
};

export const DEFAULT_NOTIFY_SPEC: NotifySpec = { default: DEFAULT_CHANNEL, channels: [DEFAULT_CHANNEL], windowMs: DEFAULT_WINDOW_MS };

export function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

export function isChannelKind(v: unknown): v is ChannelKind {
  return typeof v === "string" && (CHANNEL_KINDS as readonly string[]).includes(v);
}
