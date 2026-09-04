import type { NotifyService } from "./engine.ts";
import { parseChannelName, parseNotificationInput } from "./spec.ts";
import type { NotifyStore } from "./store.ts";
import { APP_PATTERN, type Delivery, type Notification } from "./types.ts";

/**
 * HTTP surface for notify, shaped as a Bun.serve `routes` table and merged
 * with the other Space routes by the entry point.
 *
 *   POST /api/notify                        send; 202 when queued, 200 with deliveries when `wait`
 *   GET  /api/notify/channels               every channel: name, kind, enabled, last sent, last error; no credentials
 *   POST /api/notify/channels/:name/test    send a test message to one channel (operator token only)
 *   GET  /api/notifications?app&limit       history, newest first, with deliveries
 *   GET  /api/notifications/:id             one notification and its deliveries
 *
 * The sender is identified by its bearer token: an app's own `SPACE_APP_TOKEN`
 * maps to that app; the operator's `SPACE_API_TOKEN` (or no token at all when
 * none is configured) requires an explicit `app` in the body.
 */

export type NotifyApiOptions = {
  notify: NotifyService;
  store: NotifyStore;
  /** Operator token; empty disables the check for operator routes (rely on 127.0.0.1). */
  token?: string;
  /** Resolve an app's own token to its name. */
  appForToken?: (token: string) => Promise<string | undefined>;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST", Handler>>>;

export function createNotifyRoutes(opts: NotifyApiOptions): Routes {
  const { notify, store } = opts;
  const token = opts.token?.trim() ?? "";

  const bearer = (req: Request): string => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";

  const operator =
    (h: Handler): Handler =>
    async (req) => {
      if (token && bearer(req) !== token) return error(401, "unauthorized");
      try {
        return await h(req);
      } catch (e) {
        return error(400, (e as Error).message ?? String(e));
      }
    };

  /** Who is calling: the app behind an app token, or the operator (then `app` comes from the body). */
  const resolveApp = async (req: Request, body: Record<string, unknown>): Promise<string> => {
    const presented = bearer(req);
    const fromBody = (): string => {
      if (typeof body.app !== "string" || !APP_PATTERN.test(body.app)) throw new Error("app is required when calling with the operator token");
      return body.app;
    };
    if (token && presented === token) return fromBody();
    if (presented && opts.appForToken) {
      const app = await opts.appForToken(presented);
      if (app) return app;
    }
    if (!token && !presented) return fromBody();
    throw new Unauthorized();
  };

  return {
    "/api/notify": {
      POST: async (req) => {
        try {
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          if (!body || typeof body !== "object") return error(400, "body must be a JSON object");
          const app = await resolveApp(req, body);
          const input = parseNotificationInput(body);
          const result = await notify.send(app, input);
          return json({ ok: true, notification: view(result.notification, result.deliveries) }, input.wait ? 200 : 202);
        } catch (e) {
          if (e instanceof Unauthorized) return error(401, "unauthorized");
          return error(400, (e as Error).message ?? String(e));
        }
      },
    },

    "/api/notify/channels": {
      GET: () => json({ ok: true, channels: notify.channelViews() }),
    },

    "/api/notify/channels/:name/test": {
      POST: operator(async (req) => {
        const name = parseChannelName(req.params.name, "channel");
        const result = await notify.testChannel(name);
        const failed = result.deliveries.find((d) => d.status !== "sent");
        return json({ ok: !failed, notification: view(result.notification, result.deliveries) }, failed ? 502 : 200);
      }),
    },

    "/api/notifications": {
      GET: (req) => {
        const url = new URL(req.url);
        const app = url.searchParams.get("app") ?? undefined;
        if (app !== undefined && !APP_PATTERN.test(app)) return error(400, "invalid app");
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const list = store.listNotifications({ app, limit: Number.isFinite(limit) ? limit : 50 });
        return json({ ok: true, notifications: list.map((n) => view(n, store.listDeliveries(n.id))) });
      },
    },

    "/api/notifications/:id": {
      GET: (req) => {
        const n = store.getNotification(req.params.id ?? "");
        if (!n) return error(404, `unknown notification: ${req.params.id}`);
        return json({ ok: true, notification: view(n, store.listDeliveries(n.id)) });
      },
    },
  };
}

class Unauthorized extends Error {}

export function view(n: Notification, deliveries: Delivery[]) {
  return {
    id: n.id,
    app: n.app,
    level: n.level,
    title: n.title,
    text: n.text,
    url: n.url,
    imageUrl: n.imageUrl,
    image: n.imagePath ? "uploaded" : n.imageUrl ? "link" : undefined,
    key: n.key,
    createdAt: new Date(n.createdAt).toISOString(),
    deliveries: deliveries.map((d) => ({
      channel: d.channel,
      status: d.status,
      attempts: d.attempts,
      error: d.lastError,
      providerId: d.providerId,
      sentAt: d.sentAt === undefined ? undefined : new Date(d.sentAt).toISOString(),
      updatedAt: new Date(d.updatedAt).toISOString(),
    })),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
