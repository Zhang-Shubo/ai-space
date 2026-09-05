import type { I18nText, Manifest, ManifestAgent, ManifestWidget } from "../scheduler/manifest.ts";
import type { Health } from "./health.ts";
import type { RegisteredApp } from "./registry.ts";

/**
 * What the panel API shows for apps and agents. Loopback addresses, prompts
 * and tool lists stay on the server; the browser only gets what it renders.
 * `i18n` carries the manifest's translations of the text next to it, by
 * language tag, only when there are any; the browser picks (i18n.md).
 */

export type ViewI18n = Record<string, I18nText>;

export type AgentView = {
  /** `<app>/<name>`, or `<peer>/<app>/<name>` for an agent on a peer. */
  id: string;
  /** Set when the agent lives on a peer machine; `app` and `name` stay the peer's bare names. */
  peer?: string;
  app: string;
  name: string;
  title: string;
  description?: string;
  i18n?: ViewI18n;
  /** Emoji, or a URL the panel can load. */
  avatar: string;
  /** The owning app's icon, for the corner of the agent's tile. */
  appIcon: string;
  runtime: ManifestAgent["runtime"];
};

export type AppView = {
  /** The layout key: the name, or `<peer>/<name>` for an app on a peer. */
  id: string;
  name: string;
  /** Set when the app lives on a peer machine. */
  peer?: string;
  /** True when the entry comes from a snapshot of a peer that is not answering. */
  stale?: boolean;
  title: string;
  description?: string;
  i18n?: ViewI18n;
  icon: string;
  url?: string;
  repo?: string;
  status: Manifest["status"];
  manifestOnly: boolean;
  hidden: boolean;
  service?: { port: number; health: Health | "unknown" };
  agents: AgentView[];
  widgets: { id: string; name: string; title: string; i18n?: ViewI18n; kind: string; size: string; link: string }[];
};

/** One row of the Services list: every app that declares a service, whether or not it has a tile. */
export type ServiceView = {
  app: string;
  peer?: string;
  title: string;
  i18n?: ViewI18n;
  icon: string;
  port: number;
  health: Health | "unknown";
  status: Manifest["status"];
  hidden: boolean;
};

/** The manifest's translations of the app's own text, or of one agent's / widget's, as `{ i18n }` or nothing. */
export function appI18n(m: Manifest): { i18n?: ViewI18n } {
  return pickI18n(m, (e) => e);
}
export function agentI18n(m: Manifest, a: ManifestAgent): { i18n?: ViewI18n } {
  return pickI18n(m, (e) => e.agents?.[a.name]);
}
export function widgetI18n(m: Manifest, w: ManifestWidget): { i18n?: ViewI18n } {
  return pickI18n(m, (e) => e.widgets?.[w.name]);
}
function pickI18n(m: Manifest, select: (entry: NonNullable<Manifest["i18n"]>[string]) => I18nText | undefined): { i18n?: ViewI18n } {
  const out: ViewI18n = {};
  for (const [lang, entry] of Object.entries(m.i18n ?? {})) {
    const t = select(entry);
    if (!t) continue;
    const text: I18nText = { ...(t.title !== undefined ? { title: t.title } : {}), ...(t.description !== undefined ? { description: t.description } : {}) };
    if (Object.keys(text).length) out[lang] = text;
  }
  return Object.keys(out).length ? { i18n: out } : {};
}

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
    ...agentI18n(m, a),
    avatar: avatarUrl(m, a),
    appIcon: iconUrl(m),
    runtime: a.runtime,
  };
}

export function appView(entry: RegisteredApp, opts: { hidden: boolean; health?: Health }): AppView {
  const m = entry.manifest;
  return {
    id: m.app,
    name: m.app,
    title: m.title ?? m.app,
    ...(m.description !== undefined ? { description: m.description } : {}),
    ...appI18n(m),
    icon: iconUrl(m),
    ...(m.url !== undefined ? { url: m.url } : {}),
    ...(m.repo !== undefined ? { repo: m.repo } : {}),
    status: m.status,
    manifestOnly: entry.manifestOnly,
    hidden: opts.hidden,
    ...(m.service ? { service: { port: m.service.port, health: opts.health ?? "unknown" } } : {}),
    agents: m.agents.map((a) => agentView(m, a)),
    widgets: m.widgets.map((w) => ({ id: `${m.app}/${w.name}`, name: w.name, title: w.title ?? m.title ?? m.app, ...widgetI18n(m, w), kind: w.kind, size: w.size, link: resolveLink(m, w.link) })),
  };
}

export function serviceView(entry: RegisteredApp, opts: { hidden: boolean; health?: Health }): ServiceView | undefined {
  const m = entry.manifest;
  if (!m.service) return undefined;
  return { app: m.app, title: m.title ?? m.app, ...appI18n(m), icon: iconUrl(m), port: m.service.port, health: opts.health ?? "unknown", status: m.status, hidden: opts.hidden };
}
