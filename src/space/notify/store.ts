import { Database } from "bun:sqlite";
import { type Delivery, type DeliveryStatus, type Level, type Notification } from "./types.ts";

/**
 * SQLite persistence for notifications and their deliveries, in ai-space's own
 * database next to the scheduler tables. Same migration rule: extend
 * ADDED_COLUMNS with nullable columns, never rewrite tables.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  app         TEXT NOT NULL,
  level       TEXT NOT NULL,
  title       TEXT,
  text        TEXT NOT NULL,
  url         TEXT,
  key         TEXT,
  image_url   TEXT,
  image_path  TEXT,
  image_type  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_app_created ON notifications(app, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_app_key ON notifications(app, key, created_at DESC);
CREATE TABLE IF NOT EXISTS deliveries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id  TEXT NOT NULL,
  channel          TEXT NOT NULL,
  status           TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  provider_id      TEXT,
  sent_at          INTEGER,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_notification ON deliveries(notification_id);
CREATE INDEX IF NOT EXISTS deliveries_channel_status ON deliveries(channel, status, id);
`;

const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [];

export const MAX_NOTIFICATIONS_PER_APP = 2000;

type NotificationRow = {
  id: string;
  app: string;
  level: string;
  title: string | null;
  text: string;
  url: string | null;
  key: string | null;
  image_url: string | null;
  image_path: string | null;
  image_type: string | null;
  created_at: number;
};

type DeliveryRow = {
  id: number;
  notification_id: string;
  channel: string;
  status: string;
  attempts: number;
  last_error: string | null;
  provider_id: string | null;
  sent_at: number | null;
  updated_at: number;
};

export class NotifyStore {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    for (const { table, column, ddl } of ADDED_COLUMNS) {
      const cols = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- notifications

  addNotification(n: Notification, channels: { name: string; status: DeliveryStatus; reason?: string }[]): Delivery[] {
    const insert = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO notifications (id, app, level, title, text, url, key, image_url, image_path, image_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(n.id, n.app, n.level, n.title ?? null, n.text, n.url ?? null, n.key ?? null, n.imageUrl ?? null, n.imagePath ?? null, n.imageType ?? null, n.createdAt);
      const deliveries: Delivery[] = [];
      for (const c of channels) {
        const r = this.db
          .query("INSERT INTO deliveries (notification_id, channel, status, attempts, last_error, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
          .run(n.id, c.name, c.status, c.reason ?? null, n.createdAt);
        deliveries.push({ id: Number(r.lastInsertRowid), notificationId: n.id, channel: c.name, status: c.status, attempts: 0, lastError: c.reason, updatedAt: n.createdAt });
      }
      this.db
        .query(
          `DELETE FROM deliveries WHERE notification_id IN (
             SELECT id FROM notifications WHERE app = ? AND id NOT IN (
               SELECT id FROM notifications WHERE app = ? ORDER BY created_at DESC, rowid DESC LIMIT ?))`,
        )
        .run(n.app, n.app, MAX_NOTIFICATIONS_PER_APP);
      this.db
        .query(
          `DELETE FROM notifications WHERE app = ? AND id NOT IN (
             SELECT id FROM notifications WHERE app = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
        )
        .run(n.app, n.app, MAX_NOTIFICATIONS_PER_APP);
      return deliveries;
    });
    return insert();
  }

  getNotification(id: string): Notification | undefined {
    const row = this.db.query<NotificationRow, [string]>("SELECT * FROM notifications WHERE id = ?").get(id);
    return row ? rowToNotification(row) : undefined;
  }

  listNotifications(opts: { app?: string; limit?: number } = {}): Notification[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const rows = opts.app
      ? this.db.query<NotificationRow, [string, number]>("SELECT * FROM notifications WHERE app = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(opts.app, limit)
      : this.db.query<NotificationRow, [number]>("SELECT * FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit);
    return rows.map(rowToNotification);
  }

  /** Most recent notification of an app with this key that was actually accepted (not itself deduped). */
  lastWithKey(app: string, key: string, since: number): Notification | undefined {
    const row = this.db
      .query<NotificationRow, [string, string, number]>(
        `SELECT n.* FROM notifications n
         WHERE n.app = ? AND n.key = ? AND n.created_at >= ?
           AND EXISTS (SELECT 1 FROM deliveries d WHERE d.notification_id = n.id AND d.status != 'deduped')
         ORDER BY n.created_at DESC, n.rowid DESC LIMIT 1`,
      )
      .get(app, key, since);
    return row ? rowToNotification(row) : undefined;
  }

  /** Deliveries an app produced on a channel since a point in time, excluding deduped and skipped ones. */
  countAccepted(app: string, channel: string, since: number): number {
    const row = this.db
      .query<{ n: number }, [string, string, number]>(
        `SELECT COUNT(*) AS n FROM deliveries d JOIN notifications n ON n.id = d.notification_id
         WHERE n.app = ? AND d.channel = ? AND n.created_at >= ? AND d.status IN ('queued', 'sent', 'error')`,
      )
      .get(app, channel, since);
    return row?.n ?? 0;
  }

  // ---------------------------------------------------------------- deliveries

  listDeliveries(notificationId: string): Delivery[] {
    return this.db.query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE notification_id = ? ORDER BY id").all(notificationId).map(rowToDelivery);
  }

  getDelivery(id: number): Delivery | undefined {
    const row = this.db.query<DeliveryRow, [number]>("SELECT * FROM deliveries WHERE id = ?").get(id);
    return row ? rowToDelivery(row) : undefined;
  }

  /** Oldest queued delivery on a channel, or undefined when the channel's queue is empty. */
  nextQueued(channel: string): Delivery | undefined {
    const row = this.db.query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE channel = ? AND status = 'queued' ORDER BY id LIMIT 1").get(channel);
    return row ? rowToDelivery(row) : undefined;
  }

  queuedChannels(): string[] {
    return this.db
      .query<{ channel: string }, []>("SELECT DISTINCT channel FROM deliveries WHERE status = 'queued'")
      .all()
      .map((r) => r.channel);
  }

  updateDelivery(id: number, patch: Partial<Pick<Delivery, "status" | "attempts" | "lastError" | "providerId" | "sentAt">>, now: number): void {
    const current = this.getDelivery(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .query("UPDATE deliveries SET status = ?, attempts = ?, last_error = ?, provider_id = ?, sent_at = ?, updated_at = ? WHERE id = ?")
      .run(next.status, next.attempts, next.lastError ?? null, next.providerId ?? null, next.sentAt ?? null, now, id);
  }

  /** Mark queued deliveries created before `before` as skipped. Returns how many. */
  skipStale(before: number, now: number, reason = "stale"): number {
    const r = this.db
      .query(
        `UPDATE deliveries SET status = 'skipped', last_error = ?, updated_at = ?
         WHERE status = 'queued' AND notification_id IN (SELECT id FROM notifications WHERE created_at < ?)`,
      )
      .run(reason, now, before);
    return r.changes;
  }

  /** Latest send and error per channel, for the channel listing. */
  channelStats(): Map<string, { lastSentAt?: number; lastError?: string }> {
    const out = new Map<string, { lastSentAt?: number; lastError?: string }>();
    for (const r of this.db.query<{ channel: string; sent_at: number }, []>("SELECT channel, MAX(sent_at) AS sent_at FROM deliveries WHERE status = 'sent' GROUP BY channel").all()) {
      out.set(r.channel, { lastSentAt: r.sent_at });
    }
    for (const r of this.db
      .query<{ channel: string; last_error: string }, []>(
        `SELECT d.channel, d.last_error FROM deliveries d
         WHERE d.status = 'error' AND d.id = (SELECT MAX(id) FROM deliveries WHERE channel = d.channel AND status IN ('sent', 'error'))`,
      )
      .all()) {
      out.set(r.channel, { ...out.get(r.channel), lastError: r.last_error });
    }
    return out;
  }
}

function rowToNotification(r: NotificationRow): Notification {
  return {
    id: r.id,
    app: r.app,
    level: r.level as Level,
    title: r.title ?? undefined,
    text: r.text,
    url: r.url ?? undefined,
    key: r.key ?? undefined,
    imageUrl: r.image_url ?? undefined,
    imagePath: r.image_path ?? undefined,
    imageType: r.image_type ?? undefined,
    createdAt: r.created_at,
  };
}

function rowToDelivery(r: DeliveryRow): Delivery {
  return {
    id: r.id,
    notificationId: r.notification_id,
    channel: r.channel,
    status: r.status as DeliveryStatus,
    attempts: r.attempts,
    lastError: r.last_error ?? undefined,
    providerId: r.provider_id ?? undefined,
    sentAt: r.sent_at ?? undefined,
    updatedAt: r.updated_at,
  };
}
