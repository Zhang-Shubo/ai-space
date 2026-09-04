import type { Manifest, ManifestAgent } from "../scheduler/manifest.ts";
import type { Health } from "./health.ts";
import type { RegisteredApp } from "./registry.ts";

/**
 * What the panel API shows for apps and agents. Loopback addresses, prompts
 * and tool lists stay on the server; the browser only gets what it renders.
 */

export type AgentView = {
  /** `<app>/<name>`. */
  id: string;
  app: string;
  name: string;
  title: string;
  description?: string;
  /** Emoji, or a URL the panel can load. */
  avatar: string;
  runtime: ManifestAgent["runtime"];
};

export type AppView = {
  name: string;
  title: string;
  description?: string;
  icon: string;
  url?: string;
  repo?: string;
  status: Manifest["status"];
  manifestOnly: boolean;
  hidden: boolean;
  service?: { port: number; health: Health | "unknown" };
  agents: AgentView[];
  widgets: { id: string; name: string; title: string; kind: string; size: string; link: string }[];
};

const isEmoji = (s: string) => !/^[\w./-]/.test(s) && !/^https?:\/\//.test(s) && s.length <= 8;

/** The app icon as the browser sees it: an emoji, an http(s) URL, or the icon route. */
export function iconUrl(m: Manifest): string {
  if (!m.icon) return "📦";
  if (isEmoji(m.icon) || /^https?:\/\//.test(m.icon)) return m.icon;
  return `/api/apps/${encodeURIComponent(m.app)}/icon`;
}

export function avatarUrl(m: Manifest, a: ManifestAgent): string {
  if (!a.avatar) return iconUrl(m);
  if (isEmoji(a.avatar) || /^https?:\/\//.test(a.avatar)) return a.avatar;
  return `/api/agents/${encodeURIComponent(m.app)}/${encodeURIComponent(a.name)}/avatar`;
}

/** A widget or agent link relative to the app's public URL; falls back to the app URL or empty. */
export function resolveLink(m: Manifest, link: string | undefined): string {
  if (link && /^https?:\/\//.test(link)) return link;
  if (!m.url) return "";
  if (!link) return m.url;
  try {
    return new URL(link, m.url).toString();
  } catch {
    return m.url;
  }
}

export function agentView(m: Manifest, a: ManifestAgent): AgentView {
  return {
    id: `${m.app}/${a.name}`,
    app: m.app,
    name: a.name,
    title: a.title,
    ...(a.description !== undefined ? { description: a.description } : {}),
    avatar: avatarUrl(m, a),
    runtime: a.runtime,
  };
}

export function appView(entry: RegisteredApp, opts: { hidden: boolean; health?: Health }): AppView {
  const m = entry.manifest;
  return {
    name: m.app,
    title: m.title ?? m.app,
    ...(m.description !== undefined ? { description: m.description } : {}),
    icon: iconUrl(m),
    ...(m.url !== undefined ? { url: m.url } : {}),
    ...(m.repo !== undefined ? { repo: m.repo } : {}),
    status: m.status,
    manifestOnly: entry.manifestOnly,
    hidden: opts.hidden,
    ...(m.service ? { service: { port: m.service.port, health: opts.health ?? "unknown" } } : {}),
    agents: m.agents.map((a) => agentView(m, a)),
    widgets: m.widgets.map((w) => ({ id: `${m.app}/${w.name}`, name: w.name, title: w.title ?? m.title ?? m.app, kind: w.kind, size: w.size, link: resolveLink(m, w.link) })),
  };
}
