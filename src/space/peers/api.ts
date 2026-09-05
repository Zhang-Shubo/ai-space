import type { LayoutStore } from "../panel/layout.ts";
import type { AppRegistry } from "../panel/registry.ts";
import type { PeerHub } from "./hub.ts";
import { peerId } from "./merge.ts";

/**
 * The hub side of peers, shaped as a Bun.serve `routes` table.
 *
 *   GET   /api/peers                                    every peer: health, snapshot time, counts, duplicates
 *   PATCH /api/peers/:peer/apps/:app                    { hidden }: hide a peer app on this panel only
 *   DELETE /api/peers/:peer/apps/:app                   uninstall the app on the peer (forwarded), refresh its snapshot
 *   GET   /api/peers/:peer/apps/:app/icon               ┐
 *   GET   /api/peers/:peer/apps/:app/appcolor           │
 *   GET   /api/peers/:peer/agents/:app/:agent/avatar    │ forwarded to the peer's /api/peer/... with
 *   GET   /api/peers/:peer/widgets/:app/:name/embed     │ the token and extra headers added, the
 *   POST  /api/peers/:peer/agents/:app/:agent/chat      │ answer streamed back as is
 *   GET   /api/peers/:peer/agents/:app/:agent/sessions[/:sid] ┘
 *
 * Only these paths are forwarded; anything else under /api/peers/ is 404 on
 * the hub without a call to the peer. Like the panel routes they carry no
 * bearer token; see docs/peers.md.
 */

export type PeerApiOptions = {
  hub: PeerHub;
  layout: LayoutStore;
  registry: AppRegistry;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST" | "PATCH" | "DELETE", Handler>>>;

const FORWARD_TIMEOUT_MS = 8_000;

export function createPeerRoutes(opts: PeerApiOptions): Routes {
  const { hub, layout, registry } = opts;

  const clientOf = (name: string | undefined) => {
    const c = name ? hub.get(name) : undefined;
    if (!c) throw new NotFound(`unknown peer: ${name}`);
    return c;
  };

  /** Forward to the same path on the peer with `/api/peers/<peer>` replaced by `/api/peer`. */
  const proxy =
    (timeoutMs?: number): Handler =>
    async (req) => {
      let client;
      try {
        client = clientOf(req.params.peer);
      } catch (e) {
        return error(404, (e as Error).message);
      }
      const u = new URL(req.url);
      const path = u.pathname.replace(/^\/api\/peers\/[^/]+/, "/api/peer") + u.search;
      try {
        return await client.forward(req, path, timeoutMs ? { timeoutMs } : {});
      } catch (e) {
        return error(502, `peer ${client.name} unreachable: ${String((e as Error).message ?? e).slice(0, 200)}`);
      }
    };

  return {
    "/api/peers": {
      GET: () => {
        const peers = hub.status().map((s) => ({ ...s, duplicates: duplicatesOf(s.name) }));
        return json({ ok: true, peers, asOf: new Date().toISOString() });
      },
    },

    "/api/peers/:peer/apps/:app": {
      PATCH: async (req) => {
        let client;
        try {
          client = clientOf(req.params.peer);
        } catch (e) {
          return error(404, (e as Error).message);
        }
        const app = req.params.app ?? "";
        if (!client.snapshot?.apps.some((a) => a.name === app)) return error(404, `unknown app: ${client.name}/${app}`);
        const body = (await req.json().catch(() => ({}))) as { hidden?: unknown };
        if (typeof body.hidden !== "boolean") return error(400, "hidden must be a boolean");
        const lay = layout.hide(peerId(client.name, app), body.hidden);
        const view = hub.apps(new Set(lay.hidden)).find((a) => a.id === peerId(client.name, app));
        return json({ ok: true, app: view });
      },
      // Uninstall on the peer, then refresh its snapshot so the hub's lists drop the app at once.
      DELETE: async (req) => {
        let client;
        try {
          client = clientOf(req.params.peer);
        } catch (e) {
          return error(404, (e as Error).message);
        }
        const app = req.params.app ?? "";
        if (!client.snapshot?.apps.some((a) => a.name === app)) return error(404, `unknown app: ${client.name}/${app}`);
        let res: Response;
        try {
          res = await client.forward(req, `/api/peer/apps/${encodeURIComponent(app)}`, { timeoutMs: FORWARD_TIMEOUT_MS * 10 });
        } catch (e) {
          return error(502, `peer ${client.name} unreachable: ${String((e as Error).message ?? e).slice(0, 200)}`);
        }
        if (res.ok) await client.refresh().catch(() => {});
        return res;
      },
    },

    "/api/peers/:peer/apps/:app/icon": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/apps/:app/appcolor": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/avatar": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/widgets/:app/:name/embed": { GET: proxy(FORWARD_TIMEOUT_MS) },
    // A chat stream stays open as long as the peer's does; the browser leaving aborts it.
    "/api/peers/:peer/agents/:app/:agent/chat": { POST: proxy() },
    "/api/peers/:peer/agents/:app/:agent/sessions": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/sessions/:sid": { GET: proxy(FORWARD_TIMEOUT_MS) },
  };

  /** Local manifest-only apps whose url is a peer app's url: link apps the peer makes unnecessary. */
  function duplicatesOf(peer: string): string[] {
    const snap = hub.get(peer)?.snapshot;
    if (!snap) return [];
    const urls = new Set(snap.apps.map((a) => a.url).filter((u): u is string => !!u));
    return registry
      .list()
      .filter((e) => e.manifestOnly && e.manifest.url && urls.has(e.manifest.url))
      .map((e) => e.manifest.app);
  }
}

class NotFound extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
