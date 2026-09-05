/** Types of the panel API as the browser sees them, plus tiny fetch helpers. */

export type AgentInfo = {
  id: string;
  /** Set when the agent lives on a peer machine; chat goes through /api/peers/<peer>/. */
  peer?: string;
  app: string;
  name: string;
  title: string;
  description?: string;
  avatar: string;
  /** The owning app's icon, shown in the corner of the tile. */
  appIcon: string;
  runtime: string;
};

export type AppInfo = {
  /** The layout key: the name, or `<peer>/<name>` for an app on a peer. */
  id: string;
  name: string;
  peer?: string;
  /** The peer this entry comes from is not answering; the entry is its last known state. */
  stale?: boolean;
  title: string;
  description?: string;
  icon: string;
  url?: string;
  repo?: string;
  status: "active" | "paused" | "archived";
  manifestOnly: boolean;
  hidden: boolean;
  service?: { port: number; health: "ok" | "down" | "unknown" };
  agents: AgentInfo[];
  widgets: { id: string; name: string; title: string; kind: string; size: string; link: string }[];
};

export type ServiceInfo = {
  app: string;
  peer?: string;
  title: string;
  icon: string;
  port: number;
  health: "ok" | "down" | "unknown";
  status: "active" | "paused" | "archived";
  hidden: boolean;
};

export type WidgetItem = { text: string; url: string; time: string };
export type WidgetInfo = {
  id: string;
  peer?: string;
  stale?: boolean;
  app: string;
  name: string;
  title: string;
  icon: string;
  link: string;
  kind: "items" | "embed";
  size: string;
} & ({ ok: true; items: WidgetItem[] } | { ok: false; error: string });

/** One peer machine as `GET /api/services` and `GET /api/peers` report it. */
export type PeerInfo = {
  name: string;
  url: string;
  health: "ok" | "down";
  asOf?: string;
  error?: string;
  stale: boolean;
  apps: number;
  agents: number;
  widgets: number;
  services: number;
};

export type Layout = { order: { apps: string[]; agents: string[]; widgets: string[] }; hidden: string[] };

export type ChatSession = { sid: string; title: string; ts: number };

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const j = (await r.json()) as T & { ok: boolean; error?: string };
  if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json()) as T & { ok: boolean; error?: string };
  if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/** An icon is either an emoji or something an <img> can load. */
export const isImgIcon = (s: string | undefined) => /^(https?:)?\/\//.test(s || "") || (s || "").startsWith("/");

export const repoUrl = (r: string) => {
  const m = r.match(/^git@([^:]+):(.+?)(\.git)?$/);
  return m ? `https://${m[1]}/${m[2]}` : r;
};

/** The route base of an agent's chat: local, or forwarded to the peer that owns it. */
export const agentBase = (a: { peer?: string; app: string; name: string }) =>
  `${a.peer ? `/api/peers/${encodeURIComponent(a.peer)}` : "/api"}/agents/${encodeURIComponent(a.app)}/${encodeURIComponent(a.name)}`;

export const relTime = (iso: string | number) => {
  const ms = typeof iso === "number" ? iso : new Date(iso).getTime();
  const m = Math.round((Date.now() - ms) / 60000);
  if (Number.isNaN(m)) return "";
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

// ---------------------------------------------------------------- scheduler

export type Schedule = { kind: "at"; at: string } | { kind: "every"; everyMs: number } | { kind: "cron"; expr: string; tz?: string };
export type RunStatus = "ok" | "error" | "skipped";

/** One task as `GET /api/tasks` shows it: effective values plus state, timestamps as ISO strings. */
export type TaskInfo = {
  id: string;
  app: string;
  name: string;
  description?: string;
  source: "manifest" | "api";
  orphaned: boolean;
  enabled: boolean;
  schedule: Schedule;
  target: { kind: "http" | "command" | "agent" };
  timeoutMs: number;
  overrides: { enabled?: boolean; schedule?: Schedule };
  state: {
    nextRunAt?: string;
    runningAt?: string;
    lastRunAt?: string;
    lastStatus?: RunStatus;
    lastError?: string;
    lastDurationMs?: number;
    consecutiveErrors: number;
  };
};

/** One run as `GET /api/tasks/:id/runs` shows it (epoch milliseconds). */
export type RunInfo = { id: number; taskId: string; startedAt: number; endedAt: number; status: RunStatus; error?: string; output?: string };

export const fmtDuration = (ms: number) => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
};

export const scheduleText = (s: Schedule) => {
  if (s.kind === "every") return `every ${fmtDuration(s.everyMs)}`;
  if (s.kind === "cron") return s.tz ? `${s.expr} (${s.tz})` : s.expr;
  return `once at ${new Date(s.at).toLocaleString()}`;
};

/** Forward-looking counterpart of relTime. */
export const untilTime = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms < 30_000) return "now";
  const m = Math.round(ms / 60000);
  if (m < 1) return "in <1 min";
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `in ${h} h` : `in ${Math.round(h / 24)} d`;
};
