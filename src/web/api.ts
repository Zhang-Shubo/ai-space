/** Types of the panel API as the browser sees them, plus tiny fetch helpers. */

export type AgentInfo = {
  id: string;
  app: string;
  name: string;
  title: string;
  description?: string;
  avatar: string;
  runtime: string;
};

export type AppInfo = {
  name: string;
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
  app: string;
  name: string;
  title: string;
  icon: string;
  link: string;
  kind: "items" | "embed";
  size: string;
} & ({ ok: true; items: WidgetItem[] } | { ok: false; error: string });

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

export const relTime = (iso: string | number) => {
  const ms = typeof iso === "number" ? iso : new Date(iso).getTime();
  const m = Math.round((Date.now() - ms) / 60000);
  if (Number.isNaN(m)) return "";
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};
