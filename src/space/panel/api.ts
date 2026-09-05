import { join, resolve, sep } from "node:path";
import type { PeerHub } from "../peers/hub.ts";
import type { Workspace } from "../workspace.ts";
import type { HealthProbe } from "./health.ts";
import { type LayoutStore, orderBy } from "./layout.ts";
import { createLinkApp, parseLinkApp, resolveLinkWithAgent } from "./links.ts";
import type { AppRegistry, RegisteredApp } from "./registry.ts";
import { type AppView, type ServiceView, appView, serviceView } from "./view.ts";
import { retireAppDir } from "./uninstall.ts";
import { type WidgetFeed, sourceUrl } from "./widgets.ts";

/**
 * HTTP surface for the panel, shaped as a Bun.serve `routes` table.
 *
 *   GET    /api/apps                     apps with a url, with agents and widgets (?all=1: every app)
 *   POST   /api/apps                     { link } or identity fields: create a manifest-only app
 *   GET    /api/apps/:app
 *   PATCH  /api/apps/:app                { hidden }
 *   DELETE /api/apps/:app                uninstall: stop the service, take the directory out, forget it
 *   GET    /api/apps/:app/icon
 *   GET    /api/agents/:app/:agent/avatar
 *   GET    /api/services                 every app that declares a service, with its health; peers with theirs
 *   GET    /api/widgets                  every widget's latest payload
 *   GET    /api/widgets/:app/:name/embed the page of a `kind: embed` widget, proxied from its source
 *   GET    /api/panel/layout             order + hidden
 *   PUT    /api/panel/layout             { order?: { apps?, agents?, widgets? }, hidden? }
 *   GET    /api/panel/appcolor?app=      <meta name="theme-color"> of the app's entry page
 *
 * These routes are what the browser calls. They carry no bearer token: the
 * panel is reached through the operator's tunnel and access layer, and on the
 * machine itself through loopback. See docs/panel.md.
 *
 * With peers configured, the four lists (apps, services, widgets, agents)
 * append the peers' entries after the local ones; see docs/peers.md.
 */

export type PanelApiOptions = {
  ws: Workspace;
  registry: AppRegistry;
  layout: LayoutStore;
  widgets: WidgetFeed;
  health: HealthProbe;
  /** Sync a newly created app directory into the space (provision, schedule, register). */
  onCreate: (dir: string) => Promise<void>;
  /** Forget an app the panel removed. */
  onRemove: (app: string) => Promise<void>;
  /** Stop an app's service before it is uninstalled (SPACE_SERVICE_STOP); undefined = nothing stops it. */
  stopService?: (app: string) => Promise<{ ok: boolean; error?: string }>;
  /** Turn a link into identity fields; default asks the claude runtime. */
  resolveLink?: (link: string) => Promise<Record<string, unknown>>;
  fetch?: typeof fetch;
  /** Other machines whose panels this one merges. */
  peers?: PeerHub;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST" | "PATCH" | "PUT" | "DELETE", Handler>>>;

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function createPanelRoutes(opts: PanelApiOptions): Routes {
  const { registry, layout, widgets, health, peers } = opts;
  const tier = (v: { peer?: string }) => (v.peer ? 1 : 0);
  const resolveLink = opts.resolveLink ?? ((link: string) => resolveLinkWithAgent(link));
  const colorCache = new Map<string, { at: number; color: string }>();

  const wrap =
    (h: Handler): Handler =>
    async (req) => {
      try {
        return await h(req);
      } catch (e) {
        return e instanceof NotFound ? error(404, e.message) : error(400, (e as Error).message ?? String(e));
      }
    };

  const entryOf = (name: string) => {
    const entry = registry.get(name);
    if (!entry) throw new NotFound(`unknown app: ${name}`);
    return entry;
  };

  const healthOf = async (entry: RegisteredApp) => {
    const s = entry.manifest.service;
    return s?.health && entry.manifest.status === "active" ? await health.check(s.port, s.health) : undefined;
  };

  const viewOf = async (name: string, hidden: Set<string>): Promise<AppView> => {
    const entry = entryOf(name);
    return appView(entry, { hidden: hidden.has(name), health: await healthOf(entry) });
  };

  // The grid holds what a person can open: apps with a `url`, not archived, not hidden by the
  // operator. Whether an app runs a service is a separate axis (the Services list). Agents and
  // widgets of an app without a url still show in their sections; only the tile is absent.
  const listApps = async (all: boolean): Promise<AppView[]> => {
    const lay = layout.read();
    const hidden = new Set(lay.hidden);
    const entries = registry.list().filter((e) => all || (e.manifest.url && !hidden.has(e.manifest.app) && e.manifest.status !== "archived"));
    const views = await Promise.all(entries.map((e) => viewOf(e.manifest.app, hidden)));
    // Peer snapshots already exclude what the peer hides or archived; the hub's own hidden set applies on top.
    const remote = peers?.apps(hidden).filter((v) => all || (v.url && !v.hidden)) ?? [];
    return orderBy([...views, ...remote], lay.order.apps, (v) => v.id, tier);
  };

  const listServices = async (): Promise<ServiceView[]> => {
    const hidden = new Set(layout.read().hidden);
    const rows = await Promise.all(registry.list().map(async (e) => serviceView(e, { hidden: hidden.has(e.manifest.app), health: await healthOf(e) })));
    return [...rows.filter((r): r is ServiceView => r !== undefined), ...(peers?.services(hidden) ?? [])];
  };

  return {
    "/api/apps": {
      GET: wrap(async (req) => {
        const all = new URL(req.url).searchParams.get("all") === "1";
        return json({ ok: true, apps: await listApps(all), asOf: new Date().toISOString() });
      }),
      POST: wrap(async (req) => {
        let body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (typeof body.link === "string" && body.link.trim() && !body.name) {
          const link = body.link.trim();
          if (!/^https?:\/\//.test(link)) return error(400, "link must start with http:// or https://");
          let resolved: Record<string, unknown>;
          try {
            resolved = await resolveLink(link);
          } catch (e) {
            return error(502, `could not resolve the link: ${String((e as Error).message ?? e).slice(0, 200)}`);
          }
          body = { ...resolved, ...(resolved.url ? {} : { url: link }) };
        }
        const app = parseLinkApp(body);
        if (registry.get(app.name)) return error(409, `app "${app.name}" already exists`);
        const dir = await createLinkApp(opts.ws, app);
        await opts.onCreate(dir);
        return json({ ok: true, app: await viewOf(app.name, new Set(layout.read().hidden)) }, 201);
      }),
    },

    "/api/apps/:app": {
      GET: wrap(async (req) => json({ ok: true, app: await viewOf(name(req.params.app), new Set(layout.read().hidden)) })),
      PATCH: wrap(async (req) => {
        const n = name(req.params.app);
        entryOf(n);
        const body = (await req.json().catch(() => ({}))) as { hidden?: unknown };
        if (typeof body.hidden !== "boolean") return error(400, "hidden must be a boolean");
        const lay = layout.hide(n, body.hidden);
        return json({ ok: true, app: await viewOf(n, new Set(lay.hidden)) });
      }),
      // Uninstall: the service is stopped first (a stop that fails aborts, the app stays), then the
      // directory leaves the workspace (see uninstall.ts: code is never deleted) and the app is
      // forgotten. The data directory is kept.
      DELETE: wrap(async (req) => {
        const n = name(req.params.app);
        const entry = entryOf(n);
        let stopped: "ok" | "none" | "unconfigured" = "none";
        if (entry.manifest.service) {
          if (!opts.stopService) stopped = "unconfigured";
          else {
            const r = await opts.stopService(n);
            if (!r.ok) return error(502, `stopping the service of "${n}" failed: ${r.error ?? "unknown error"}`);
            stopped = "ok";
          }
        }
        const dir = await retireAppDir(opts.ws, n, entry.manifest.dir, entry.manifestOnly);
        registry.remove(n);
        await opts.onRemove(n);
        return json({ ok: true, app: n, stopped, dir, data: join(opts.ws.data, n) });
      }),
    },

    "/api/apps/:app/icon": {
      GET: wrap(async (req) => {
        const m = entryOf(name(req.params.app)).manifest;
        if (!m.icon) throw new NotFound("app has no icon");
        return serveFile(m.dir, m.icon);
      }),
    },

    "/api/agents/:app/:agent/avatar": {
      GET: wrap(async (req) => {
        const m = entryOf(name(req.params.app)).manifest;
        const a = m.agents.find((x) => x.name === req.params.agent);
        if (!a) throw new NotFound(`unknown agent: ${req.params.app}/${req.params.agent}`);
        return serveFile(m.dir, a.avatar ?? m.icon ?? "");
      }),
    },

    "/api/services": {
      GET: wrap(async () => json({ ok: true, services: await listServices(), peers: peers?.status() ?? [], asOf: new Date().toISOString() })),
    },

    "/api/widgets": {
      GET: wrap(async () => {
        const lay = layout.read();
        const hidden = new Set(lay.hidden);
        const all = [...(await widgets.all()).filter((w) => !hidden.has(w.app)), ...(peers?.widgets(hidden) ?? [])];
        return json({ ok: true, widgets: orderBy(all, lay.order.widgets, (w) => w.id, tier), asOf: new Date().toISOString() });
      }),
    },

    "/api/widgets/:app/:name/embed": {
      GET: wrap(async (req) => {
        const m = entryOf(name(req.params.app)).manifest;
        const w = m.widgets.find((x) => x.name === req.params.name && x.kind === "embed");
        if (!w) throw new NotFound(`unknown embed widget: ${req.params.app}/${req.params.name}`);
        const url = sourceUrl(m, w);
        if (!url) return error(502, "source is a path but the app declares no service");
        const theme = new URL(req.url).searchParams.get("theme") === "dark" ? "dark" : "light";
        const target = new URL(url);
        target.searchParams.set("theme", theme);
        let upstream: Response;
        try {
          upstream = await (opts.fetch ?? fetch)(target, { signal: AbortSignal.timeout(8_000) });
        } catch (e) {
          return error(502, `widget page unavailable: ${String((e as Error).message ?? e).slice(0, 200)}`);
        }
        return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "text/html; charset=utf-8", "cache-control": "no-store" } });
      }),
    },

    "/api/panel/layout": {
      GET: () => json({ ok: true, layout: layout.read() }),
      PUT: wrap(async (req) => {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return error(400, "body must be a JSON object");
        return json({ ok: true, layout: layout.update(body) });
      }),
    },

    "/api/panel/appcolor": {
      GET: wrap(async (req) => {
        const n = name(new URL(req.url).searchParams.get("app") ?? "");
        const m = entryOf(n).manifest;
        if (!m.url) throw new NotFound("app has no url");
        const hit = colorCache.get(n);
        if (hit && Date.now() - hit.at < 3_600_000) return json({ ok: true, color: hit.color });
        // The public entry may sit behind an access layer; a local service is probed on loopback instead.
        const probe = m.service ? `http://127.0.0.1:${m.service.port}/` : m.url;
        let color = "";
        try {
          const r = await (opts.fetch ?? fetch)(probe, { signal: AbortSignal.timeout(5_000) });
          const html = (await r.text()).slice(0, 65_536);
          const mm = html.match(/<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/i) ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']theme-color["']/i);
          if (mm?.[1]) color = mm[1].trim().slice(0, 32);
        } catch {
          /* unreachable: report no color rather than a guess */
        }
        colorCache.set(n, { at: Date.now(), color });
        return json({ ok: true, color });
      }),
    },
  };
}

// ---------------------------------------------------------------- helpers

class NotFound extends Error {}

function name(v: string | undefined): string {
  const n = (v ?? "").trim();
  if (!NAME_RE.test(n)) throw new Error("invalid app name");
  return n;
}

/** Serve a file from inside an app directory; paths that escape it are 404. */
async function serveFile(dir: string, rel: string): Promise<Response> {
  const root = resolve(dir);
  const path = resolve(root, rel);
  if (!rel || (path !== root && !path.startsWith(root + sep))) throw new NotFound("file not found");
  const file = Bun.file(path);
  if (!(await file.exists())) throw new NotFound("file not found");
  return new Response(file, { headers: { "cache-control": "no-cache" } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
