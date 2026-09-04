import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotifyStore } from "./store.ts";
import { type Fetch, TRANSPORTS, TransportError } from "./transports.ts";
import {
  type Channel,
  type ChannelView,
  DEFAULT_NOTIFY_SPEC,
  type Delivery,
  type DeliveryStatus,
  FINAL_STATUSES,
  MAX_IMAGE_BYTES,
  type Notification,
  type NotificationInput,
  type NotifySpec,
} from "./types.ts";

/**
 * Notify engine: an outbox with one worker per channel.
 *
 * `send` validates, resolves channels, applies dedup and the per-app cap,
 * writes the notification with one delivery per channel and returns. Workers
 * drain each channel's queue in order, keep the channel's minimum gap between
 * sends, retry transient errors, wait out 429s, and record every attempt.
 *
 * Rules:
 * - the app is never blocked: the default call returns before any network
 *   activity; `wait` exists for the last message before a process exits;
 * - a keyed notification inside its window is recorded as deduped, not sent;
 * - past CAP notifications per app and channel in CAP_WINDOW_MS, the rest are
 *   skipped and one notice goes out;
 * - queued deliveries older than STALE_MS are skipped instead of arriving late;
 * - a disabled or unconfigured channel records `skipped`; enabling it later
 *   does not replay history.
 */

export const STALE_MS = 60 * 60_000;
export const CAP = 30;
export const CAP_WINDOW_MS = 10 * 60_000;
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
const MAX_RATE_WAITS = 5;
const MAX_RATE_WAIT_MS = 60_000;
/** App name used for ai-space's own messages (channel tests, task reports carry the task's app). */
export const SPACE_APP = "space";

export type NotifyOptions = {
  store: NotifyStore;
  channels: Map<string, Channel>;
  /** Channels whose URL failed to parse, by name, with the reason. */
  channelErrors?: Map<string, string>;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** Directory for uploaded image bytes of an app while they wait for delivery. */
  imageDir?: (app: string) => string;
};

export type SendOptions = {
  /** ai-space's own messages: skip the app's channel allow-list and the per-app cap. */
  internal?: boolean;
};

export type SendResult = { notification: Notification; deliveries: Delivery[] };

export class NotifyService {
  private readonly store: NotifyStore;
  private readonly channels: Map<string, Channel>;
  private readonly channelErrors: Map<string, string>;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly imageDir: (app: string) => string;
  private readonly specs = new Map<string, NotifySpec>();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly waiters = new Map<number, (() => void)[]>();
  private stopped = false;

  constructor(opts: NotifyOptions) {
    this.store = opts.store;
    this.channels = opts.channels;
    this.channelErrors = opts.channelErrors ?? new Map();
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? ((m) => console.log(`[notify] ${m}`));
    this.imageDir = opts.imageDir ?? ((app) => join(tmpdir(), "ai-space-notify", app));
  }

  // ---------------------------------------------------------------- lifecycle

  /** Skip what is too old to still be useful, then resume every channel with queued work. */
  start(): void {
    this.stopped = false;
    const now = this.now();
    const stale = this.store.skipStale(now - STALE_MS, now);
    if (stale) this.log(`skipped ${stale} queued deliver${stale === 1 ? "y" : "ies"} older than an hour`);
    for (const name of this.store.queuedChannels()) this.kick(name);
    const configured = [...this.channels.values()];
    this.log(`${configured.length} channel(s): ${configured.map((c) => `${c.name}=${c.kind}${c.enabled ? "" : " (disabled)"}`).join(", ") || "none"}`);
    for (const [name, err] of this.channelErrors) this.log(`channel ${name} ignored: ${err}`);
  }

  /** Stop taking new queue items; the item in flight finishes. */
  stop(): void {
    this.stopped = true;
  }

  /** Resolves once every worker has drained or stopped. */
  async idle(): Promise<void> {
    while (this.workers.size > 0) await Promise.allSettled([...this.workers.values()]);
  }

  // ---------------------------------------------------------------- apps

  syncApp(app: string, spec: NotifySpec): void {
    this.specs.set(app, spec);
    for (const name of spec.channels) {
      if (!this.channels.has(name) && name !== DEFAULT_NOTIFY_SPEC.default) this.log(`${app}: channel "${name}" is declared but not configured; sends to it will be skipped`);
    }
  }

  specFor(app: string): NotifySpec {
    return this.specs.get(app) ?? DEFAULT_NOTIFY_SPEC;
  }

  appTitle(app: string): string {
    return this.specFor(app).title ?? app;
  }

  // ---------------------------------------------------------------- send

  async send(app: string, input: NotificationInput, opts: SendOptions = {}): Promise<SendResult> {
    const spec = this.specFor(app);
    const now = this.now();
    const requested = input.channels?.length ? input.channels : [spec.default];
    if (!opts.internal) {
      for (const name of requested) {
        if (!spec.channels.includes(name)) throw new Error(`channel "${name}" is not in the app's notify.channels (${spec.channels.join(", ")})`);
      }
    }

    const notification: Notification = {
      id: `n_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      app,
      level: input.level ?? "info",
      ...(input.title ? { title: input.title } : {}),
      text: input.text,
      ...(input.url ? { url: input.url } : {}),
      ...(input.key ? { key: input.key } : {}),
      createdAt: now,
    };

    let duplicateOf: string | undefined;
    if (input.key) {
      const windowMs = input.windowMs ?? spec.windowMs;
      duplicateOf = this.store.lastWithKey(app, input.key, now - windowMs)?.id;
    }

    if (input.image && !duplicateOf) {
      if ("url" in input.image) {
        notification.imageUrl = input.image.url;
      } else {
        const bytes = Buffer.from(input.image.data, "base64");
        if (bytes.byteLength === 0) throw new Error("image.data is not valid base64");
        if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("image exceeds 5 MB");
        const dir = this.imageDir(app);
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${notification.id}.${input.image.type.split("/")[1]}`);
        await Bun.write(path, bytes);
        notification.imagePath = path;
        notification.imageType = input.image.type;
      }
    }

    const plan: { name: string; status: DeliveryStatus; reason?: string }[] = [];
    const capped: string[] = [];
    for (const name of new Set(requested)) {
      if (duplicateOf) {
        plan.push({ name, status: "deduped", reason: `duplicate of ${duplicateOf}` });
        continue;
      }
      const channel = this.channels.get(name);
      if (!channel) {
        const err = this.channelErrors.get(name);
        plan.push({ name, status: "skipped", reason: err ? `channel misconfigured: ${err}` : "channel not configured" });
        continue;
      }
      if (!channel.enabled) {
        plan.push({ name, status: "skipped", reason: "channel disabled" });
        continue;
      }
      if (!opts.internal && this.store.countAccepted(app, name, now - CAP_WINDOW_MS) >= CAP) {
        plan.push({ name, status: "skipped", reason: `rate limit: ${CAP} notifications in ${CAP_WINDOW_MS / 60_000} minutes` });
        capped.push(name);
        continue;
      }
      plan.push({ name, status: "queued" });
    }

    const deliveries = this.store.addNotification(notification, plan);
    for (const d of deliveries) if (d.status === "queued") this.kick(d.channel);

    for (const name of capped) {
      const until = new Date(now + CAP_WINDOW_MS).toISOString().slice(11, 16);
      void this.send(
        app,
        {
          level: "warn",
          title: "Notifications suppressed",
          text: `${this.appTitle(app)} sent ${CAP} notifications to "${name}" in ${CAP_WINDOW_MS / 60_000} minutes. Further ones are skipped until ${until} UTC.`,
          channels: [name],
          key: `_rate-limit:${name}`,
          windowMs: CAP_WINDOW_MS,
        },
        { internal: true },
      ).catch((e) => this.log(`rate-limit notice failed: ${(e as Error).message}`));
    }

    if (input.wait) {
      await this.waitFor(deliveries.filter((d) => d.status === "queued").map((d) => d.id));
      return { notification, deliveries: this.store.listDeliveries(notification.id) };
    }
    return { notification, deliveries };
  }

  /** Send a test message to one channel, bypassing app rules. Resolves with the delivery result. */
  async testChannel(name: string): Promise<SendResult> {
    if (!this.channels.has(name)) throw new Error(this.channelErrors.get(name) ?? `unknown channel: ${name}`);
    return this.send(SPACE_APP, { level: "info", title: "Test", text: `Channel "${name}" is reachable from ai-space.`, channels: [name], wait: true }, { internal: true });
  }

  channelViews(): ChannelView[] {
    const stats = this.store.channelStats();
    const views: ChannelView[] = [];
    for (const c of [...this.channels.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const s = stats.get(c.name);
      views.push({
        name: c.name,
        kind: c.kind,
        enabled: c.enabled,
        ...(s?.lastSentAt ? { lastSentAt: new Date(s.lastSentAt).toISOString() } : {}),
        ...(s?.lastError ? { lastError: s.lastError } : {}),
      });
    }
    for (const [name, error] of this.channelErrors) views.push({ name, enabled: false, error });
    return views;
  }

  // ---------------------------------------------------------------- workers

  private kick(channel: string): void {
    if (this.stopped || this.workers.has(channel)) return;
    const p = this.drain(channel)
      .catch((e) => this.log(`worker ${channel} failed: ${(e as Error).message ?? String(e)}`))
      .finally(() => {
        this.workers.delete(channel);
        if (!this.stopped && this.store.nextQueued(channel)) this.kick(channel);
      });
    this.workers.set(channel, p);
  }

  private async drain(name: string): Promise<void> {
    while (!this.stopped) {
      const d = this.store.nextQueued(name);
      if (!d) return;
      const now = this.now();
      const n = this.store.getNotification(d.notificationId);
      const channel = this.channels.get(name);
      if (!n) {
        this.store.updateDelivery(d.id, { status: "skipped", lastError: "notification gone" }, now);
      } else if (!channel || !channel.enabled) {
        this.store.updateDelivery(d.id, { status: "skipped", lastError: channel ? "channel disabled" : "channel not configured" }, now);
      } else if (now - n.createdAt > STALE_MS) {
        this.store.updateDelivery(d.id, { status: "skipped", lastError: "stale" }, now);
      } else {
        await this.attempt(channel, n, d);
        if (channel.limits.gapMs > 0) await this.sleep(channel.limits.gapMs);
      }
      await this.cleanupImage(d.notificationId);
      this.settle(d.id);
    }
  }

  private async attempt(channel: Channel, n: Notification, d: Delivery): Promise<void> {
    let attempts = d.attempts;
    let rateWaits = 0;
    const image = n.imagePath ? await this.readImage(n) : undefined;
    for (;;) {
      try {
        const result = await TRANSPORTS[channel.kind]({ channel, notification: n, appTitle: this.appTitle(n.app), ...(image ? { image } : {}) }, this.fetch, this.log);
        this.store.updateDelivery(d.id, { status: "sent", attempts: attempts + 1, providerId: result.providerId, sentAt: this.now(), lastError: result.degraded }, this.now());
        if (result.degraded) this.log(`${n.app} → ${channel.name}: sent, ${result.degraded}`);
        return;
      } catch (e) {
        const err = e instanceof TransportError ? e : new TransportError((e as Error).message ?? String(e));
        if (err.retryAfterMs !== undefined && rateWaits < MAX_RATE_WAITS) {
          rateWaits++;
          const wait = Math.min(err.retryAfterMs, MAX_RATE_WAIT_MS);
          this.store.updateDelivery(d.id, { lastError: `${err.message} (waiting ${Math.ceil(wait / 1000)}s)` }, this.now());
          this.log(`${n.app} → ${channel.name}: rate limited, waiting ${Math.ceil(wait / 1000)}s`);
          await this.sleep(wait);
          continue;
        }
        attempts++;
        const giveUp = err.final || attempts > RETRY_DELAYS_MS.length;
        this.store.updateDelivery(d.id, { ...(giveUp ? { status: "error" } : {}), attempts, lastError: err.message }, this.now());
        if (giveUp) {
          this.log(`${n.app} → ${channel.name}: failed after ${attempts} attempt(s): ${err.message}`);
          return;
        }
        await this.sleep(RETRY_DELAYS_MS[attempts - 1]!);
      }
    }
  }

  private async readImage(n: Notification): Promise<{ bytes: Uint8Array; type: string } | undefined> {
    try {
      return { bytes: new Uint8Array(await Bun.file(n.imagePath!).arrayBuffer()), type: n.imageType ?? "image/png" };
    } catch (e) {
      this.log(`${n.app}: image ${n.imagePath} unreadable, sending text only: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Delete parked image bytes once no delivery of the notification is still queued. */
  private async cleanupImage(notificationId: string): Promise<void> {
    const n = this.store.getNotification(notificationId);
    if (!n?.imagePath) return;
    if (!this.store.listDeliveries(notificationId).every((d) => FINAL_STATUSES.includes(d.status))) return;
    await unlink(n.imagePath).catch(() => {});
  }

  private waitFor(ids: number[]): Promise<void> {
    return Promise.all(
      ids.map(
        (id) =>
          new Promise<void>((resolve) => {
            const d = this.store.getDelivery(id);
            if (!d || FINAL_STATUSES.includes(d.status)) return resolve();
            this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
          }),
      ),
    ).then(() => undefined);
  }

  private settle(id: number): void {
    const list = this.waiters.get(id);
    if (!list) return;
    this.waiters.delete(id);
    for (const resolve of list) resolve();
  }
}
