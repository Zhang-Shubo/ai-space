import type { AgentView, AppView, ServiceView } from "../panel/view.ts";
import type { WidgetView } from "../panel/widgets.ts";
import type { PeerConfig } from "./config.ts";
import type { PeerStore } from "./store.ts";

/**
 * One peer as the hub sees it: a snapshot of its panel refreshed on a timer,
 * the last good copy kept when a refresh fails, and a forwarder for the
 * requests that must run on the peer (chat, sessions, embed pages, icons).
 * A browser request never waits for a peer: lists read the cached snapshot.
 */

export type PeerSnapshot = {
  /** What the peer calls itself (`SPACE_NAME`); informative only. */
  name: string;
  apps: AppView[];
  services: ServiceView[];
  widgets: WidgetView[];
  agents: AgentView[];
  asOf: string;
};

export type PeerHealth = "ok" | "down";

export type PeerStatus = {
  name: string;
  url: string;
  health: PeerHealth;
  /** Time of the snapshot on show, when there is one. */
  asOf?: string;
  /** Why the last refresh failed, when it did. */
  error?: string;
  /** True when the snapshot on show is older than the health window (the peer is down). */
  stale: boolean;
  apps: number;
  agents: number;
  widgets: number;
  services: number;
};

export const SNAPSHOT_PATH = "/api/peer/snapshot";
const SNAPSHOT_TIMEOUT_MS = 8_000;
/** A snapshot older than this many refresh periods counts as stale. */
const STALE_PERIODS = 2;

export class PeerClient {
  snapshot: PeerSnapshot | undefined;
  error: string | undefined;
  private lastOkAt: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    readonly config: PeerConfig,
    private readonly opts: { store?: PeerStore; fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.snapshot = opts.store?.get(config.name);
  }

  get name(): string {
    return this.config.name;
  }

  /** `ok` while the last successful refresh is recent; a restored snapshot alone is not. */
  health(): PeerHealth {
    return this.lastOkAt !== undefined && this.now() - this.lastOkAt < this.config.refreshMs * STALE_PERIODS ? "ok" : "down";
  }

  status(): PeerStatus {
    const s = this.snapshot;
    return {
      name: this.name,
      url: this.config.url,
      health: this.health(),
      ...(s ? { asOf: s.asOf } : {}),
      ...(this.error ? { error: this.error } : {}),
      stale: this.health() !== "ok",
      apps: s?.apps.length ?? 0,
      agents: s?.agents.length ?? 0,
      widgets: s?.widgets.length ?? 0,
      services: s?.services.length ?? 0,
    };
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Fetch the snapshot once; a failure keeps the previous snapshot and records the reason. */
  refresh(): Promise<void> {
    if (!this.inFlight) this.inFlight = this.refreshOnce().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private async refreshOnce(): Promise<void> {
    try {
      const r = await this.fetch(this.config.url + SNAPSHOT_PATH, { headers: this.headers(), signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
      if (r.status === 401 || r.status === 403) throw new Error("token rejected");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const snap = parseSnapshot(await r.json());
      this.snapshot = snap;
      this.error = undefined;
      this.lastOkAt = this.now();
      this.opts.store?.set(this.name, snap);
    } catch (e) {
      this.error = String((e as Error).message ?? e).slice(0, 200);
    }
  }

  /**
   * Forward a browser request to the peer's `/api/peer/...` path and stream the
   * answer back. Bodies are small JSON, so they are read whole; the response
   * body (a file, a page, an SSE stream) is passed through as it arrives.
   */
  async forward(req: Request, path: string, opts: { timeoutMs?: number } = {}): Promise<Response> {
    const headers = this.headers();
    const ct = req.headers.get("content-type");
    if (ct) headers["content-type"] = ct;
    const init: RequestInit = { method: req.method, headers, signal: opts.timeoutMs ? AbortSignal.any([req.signal, AbortSignal.timeout(opts.timeoutMs)]) : req.signal };
    if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.text();
    const up = await this.fetch(this.config.url + path, init);
    return new Response(up.body, { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" } });
  }

  private headers(): Record<string, string> {
    return { ...this.config.headers, ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) };
  }

  private get fetch(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}

/** Accept only the shape the hub relies on; anything else is a peer of another version. */
export function parseSnapshot(j: unknown): PeerSnapshot {
  const o = j as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.ok !== true) throw new Error(typeof o?.error === "string" ? o.error : "not a snapshot");
  for (const k of ["apps", "services", "widgets", "agents"]) if (!Array.isArray(o[k])) throw new Error(`snapshot has no ${k} list`);
  return {
    name: typeof o.name === "string" ? o.name : "",
    apps: o.apps as AppView[],
    services: o.services as ServiceView[],
    widgets: o.widgets as WidgetView[],
    agents: o.agents as AgentView[],
    asOf: typeof o.asOf === "string" ? o.asOf : new Date().toISOString(),
  };
}
