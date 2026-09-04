import { SPACE_AGENT, SPACE_APP } from "../agents/api.ts";

/**
 * The peer side: `/api/peer/*`, present only when `SPACE_HUB_TOKEN` is set.
 * Every route requires that bearer token and mirrors a panel or agent route
 * the browser already uses, with the same handler behind the check, plus one
 * snapshot that bundles the four lists a hub merges. Nothing here mutates the
 * peer.
 *
 *   GET  /api/peer/snapshot                        { ok, name, apps, services, widgets, agents, asOf }
 *   GET  /api/peer/apps/:app/icon                  = /api/apps/:app/icon
 *   GET  /api/peer/apps/:app/appcolor              = /api/panel/appcolor?app=
 *   GET  /api/peer/agents/:app/:agent/avatar       = /api/agents/:app/:agent/avatar
 *   GET  /api/peer/widgets/:app/:name/embed        = /api/widgets/:app/:name/embed
 *   POST /api/peer/agents/:app/:agent/chat         = /api/agents/:app/:agent/chat
 *   GET  /api/peer/agents/:app/:agent/sessions[/:sid]
 */

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Routes = Record<string, Handler | Partial<Record<Method, Handler>>>;

export type PeerServeOptions = {
  token: string;
  /** What this space calls itself (`SPACE_NAME`). */
  name: string;
  panel: Routes;
  agents: Routes;
};

export function createPeerServeRoutes(opts: PeerServeOptions): Routes {
  if (!opts.token) return {};
  const expected = `Bearer ${opts.token}`;

  const guard =
    (h: Handler): Handler =>
    async (req) => {
      if (req.headers.get("authorization") !== expected) return json({ ok: false, error: "unauthorized" }, 401);
      try {
        return await h(req);
      } catch (e) {
        return json({ ok: false, error: (e as Error).message ?? String(e) }, 400);
      }
    };

  const mirror = (routes: Routes, path: string, method: Method): Handler => {
    const h = handlerOf(routes, path, method);
    return (req) => h(req);
  };

  /** Call a local GET route in-process and return its JSON body. */
  const local = async <T>(routes: Routes, path: string, base: string): Promise<T> => {
    const req = Object.assign(new Request(new URL(path, base)), { params: {} as Record<string, string> });
    const r = await handlerOf(routes, path, "GET")(req);
    return (await r.json()) as T;
  };

  return {
    "/api/peer/snapshot": {
      GET: guard(async (req) => {
        const base = new URL(req.url).origin;
        const [apps, services, widgets, agents] = await Promise.all([
          local<{ apps: unknown[] }>(opts.panel, "/api/apps", base),
          local<{ services: unknown[] }>(opts.panel, "/api/services", base),
          local<{ widgets: unknown[] }>(opts.panel, "/api/widgets", base),
          local<{ agents: { id: string }[] }>(opts.agents, "/api/agents", base),
        ]);
        return json({
          ok: true,
          name: opts.name,
          apps: apps.apps,
          services: services.services,
          widgets: widgets.widgets,
          // The hub has its own space agent.
          agents: agents.agents.filter((a) => a.id !== `${SPACE_APP}/${SPACE_AGENT}`),
          asOf: new Date().toISOString(),
        });
      }),
    },
    "/api/peer/apps/:app/icon": { GET: guard(mirror(opts.panel, "/api/apps/:app/icon", "GET")) },
    "/api/peer/apps/:app/appcolor": {
      GET: guard((req) => {
        const url = new URL("/api/panel/appcolor", req.url);
        url.searchParams.set("app", req.params.app ?? "");
        return handlerOf(opts.panel, "/api/panel/appcolor", "GET")(Object.assign(new Request(url), { params: {} }));
      }),
    },
    "/api/peer/agents/:app/:agent/avatar": { GET: guard(mirror(opts.panel, "/api/agents/:app/:agent/avatar", "GET")) },
    "/api/peer/widgets/:app/:name/embed": { GET: guard(mirror(opts.panel, "/api/widgets/:app/:name/embed", "GET")) },
    "/api/peer/agents/:app/:agent/chat": { POST: guard(mirror(opts.agents, "/api/agents/:app/:agent/chat", "POST")) },
    "/api/peer/agents/:app/:agent/sessions": { GET: guard(mirror(opts.agents, "/api/agents/:app/:agent/sessions", "GET")) },
    "/api/peer/agents/:app/:agent/sessions/:sid": { GET: guard(mirror(opts.agents, "/api/agents/:app/:agent/sessions/:sid", "GET")) },
  };
}

function handlerOf(routes: Routes, path: string, method: Method): Handler {
  const entry = routes[path];
  const h = typeof entry === "function" ? entry : entry?.[method];
  if (!h) throw new Error(`no ${method} handler for ${path}`);
  return h;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
