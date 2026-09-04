import type { Manifest, ManifestWidget } from "../scheduler/manifest.ts";
import { iconUrl, resolveLink } from "./view.ts";
import type { AppRegistry } from "./registry.ts";

/**
 * Widget feed: fetches every declared `kind: items` widget through ai-space,
 * caches each for its `refresh`, and only ever calls URLs a manifest declares.
 * Sources may be loopback addresses; they never reach the browser. A failing
 * source is reported as `{ ok: false, error }` and shown as is, never invented.
 */

export type WidgetItem = { text: string; url: string; time: string };

export type WidgetView = {
  /** `<app>/<name>`, or `<peer>/<app>/<name>` for a widget on a peer. */
  id: string;
  peer?: string;
  /** True when the payload is the last one seen from a peer that is not answering. */
  stale?: boolean;
  app: string;
  name: string;
  title: string;
  icon: string;
  link: string;
  kind: "items" | "embed";
  size: ManifestWidget["size"];
  refreshMs: number;
} & ({ ok: true; items: WidgetItem[] } | { ok: false; error: string });

const MAX_ITEMS = 20;

export class WidgetFeed {
  private readonly cache = new Map<string, { at: number; data: { ok: true; items: WidgetItem[] } | { ok: false; error: string } }>();

  constructor(
    private readonly registry: AppRegistry,
    private readonly opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {}

  /** Every widget of every visible app, in registry order (the API applies the layout order). */
  async all(): Promise<WidgetView[]> {
    const out: Promise<WidgetView>[] = [];
    for (const { manifest } of this.registry.list()) {
      if (manifest.status === "archived") continue;
      for (const w of manifest.widgets) out.push(this.one(manifest, w));
    }
    return Promise.all(out);
  }

  async one(m: Manifest, w: ManifestWidget): Promise<WidgetView> {
    const id = `${m.app}/${w.name}`;
    const base = {
      id,
      app: m.app,
      name: w.name,
      title: w.title ?? m.title ?? m.app,
      icon: iconUrl(m),
      link: resolveLink(m, w.link),
      kind: w.kind,
      size: w.size,
      refreshMs: w.refreshMs,
    };
    if (w.kind === "embed") return { ...base, ok: true, items: [] };
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < w.refreshMs) return { ...base, ...hit.data };
    const data = await this.fetchItems(m, w);
    this.cache.set(id, { at: Date.now(), data });
    return { ...base, ...data };
  }

  private async fetchItems(m: Manifest, w: ManifestWidget): Promise<{ ok: true; items: WidgetItem[] } | { ok: false; error: string }> {
    const url = sourceUrl(m, w);
    if (!url) return { ok: false, error: "source is a path but the app declares no service" };
    try {
      const r = await (this.opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { ok?: unknown; items?: unknown; error?: unknown };
      if (j.ok !== true || !Array.isArray(j.items)) throw new Error(typeof j.error === "string" ? j.error : "response is not { ok: true, items: [] }");
      const items = j.items.slice(0, MAX_ITEMS).map((it: Record<string, unknown>) => ({
        text: String(it?.text ?? ""),
        url: typeof it?.url === "string" ? it.url : "",
        time: typeof it?.time === "string" ? it.time : "",
      }));
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
    }
  }
}

/** Absolute URL of a widget source, or undefined when a path has no service to attach to. */
export function sourceUrl(m: Manifest, w: ManifestWidget): string | undefined {
  if (/^https?:\/\//.test(w.source)) return w.source;
  if (!m.service) return undefined;
  return `http://127.0.0.1:${m.service.port}${w.source}`;
}
