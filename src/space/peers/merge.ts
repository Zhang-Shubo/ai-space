import type { AgentView, AppView, ServiceView } from "../panel/view.ts";
import type { WidgetView } from "../panel/widgets.ts";
import type { PeerSnapshot } from "./client.ts";

/**
 * Turn a peer's snapshot into hub views: ids get the `<peer>/` prefix, file
 * routes are rewritten to the hub's proxy, the hub's own hidden set applies,
 * and a stale snapshot reports no health it cannot vouch for.
 */

export const peerId = (peer: string, id: string) => `${peer}/${id}`;

/** A path route on the peer (`/api/apps/x/icon`) becomes the hub's proxy route; emoji and absolute URLs pass. */
export function peerRoute(peer: string, s: string): string {
  return s.startsWith("/api/") ? `/api/peers/${encodeURIComponent(peer)}/${s.slice("/api/".length)}` : s;
}

export function mergeAgent(peer: string, a: AgentView): AgentView {
  return { ...a, id: peerId(peer, a.id), peer, avatar: peerRoute(peer, a.avatar), appIcon: peerRoute(peer, a.appIcon) };
}

/** Every app of the snapshot, `hidden` set from the hub's layout; the caller filters. */
export function mergeApps(peer: string, snap: PeerSnapshot, hidden: Set<string>, stale: boolean): AppView[] {
  return snap.apps.map((a) => ({
    ...a,
    id: peerId(peer, a.name),
    peer,
    stale,
    icon: peerRoute(peer, a.icon),
    hidden: hidden.has(peerId(peer, a.name)),
    // A peer app is never deleted from the hub, whatever it is on its own machine.
    manifestOnly: false,
    ...(a.service ? { service: { port: a.service.port, health: stale ? "unknown" : a.service.health } } : {}),
    agents: a.agents.map((ag) => mergeAgent(peer, ag)),
    widgets: a.widgets.map((w) => ({ ...w, id: peerId(peer, w.id) })),
  }));
}

/** Agents of apps the hub does not hide. */
export function mergeAgents(peer: string, snap: PeerSnapshot, hidden: Set<string>): AgentView[] {
  return snap.agents.filter((a) => !hidden.has(peerId(peer, a.app))).map((a) => mergeAgent(peer, a));
}

/** Widgets of apps the hub does not hide; items keep their last payload, marked stale when the peer is. */
export function mergeWidgets(peer: string, snap: PeerSnapshot, hidden: Set<string>, stale: boolean): WidgetView[] {
  return snap.widgets.filter((w) => !hidden.has(peerId(peer, w.app))).map((w) => ({ ...w, id: peerId(peer, w.id), peer, stale, icon: peerRoute(peer, w.icon) }));
}

export function mergeServices(peer: string, snap: PeerSnapshot, hidden: Set<string>, stale: boolean): ServiceView[] {
  return snap.services.map((s) => ({ ...s, peer, icon: peerRoute(peer, s.icon), health: stale ? "unknown" : s.health, hidden: s.hidden || hidden.has(peerId(peer, s.app)) }));
}
