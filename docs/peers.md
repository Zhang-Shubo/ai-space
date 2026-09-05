# Peers: one panel over several machines

Status: implemented (`src/space/peers/`). What is still open is listed under Later.

## Problem

An ai-space owns one machine: its workspace, its `space.db`, its loopback services. Apps live where they are deployed, and some machines are better homes than others (a box with a public IP and sudo, a box behind a tunnel with neither, a laptop). The panel, however, is one page the operator opens, and it should show every app, every agent, every widget and every service the operator has, wherever it runs.

Without peers the panel on the hub machine only knows the apps in its own `apps/`. An app deployed elsewhere reaches the panel as a manifest-only link app: a tile, no health, no chat, no widget unless the source is a public URL. That is a copy of the app's identity, maintained by hand, that drifts.

## Shape

One ai-space per machine, unchanged. One of them is the **hub**: the operator's `.env` on that machine lists the other spaces as **peers** (name, URL, token). The hub asks each peer for what its panel would show, merges it into its own panel under the peer's name, and forwards the requests that need the app's machine (chat, sessions, embed pages, icon files) to that peer. Peers do not know about the hub or about each other. Nothing is shared: no database, no workspace, no files.

```
browser ── hub ai-space ──────────── its own apps, agents, widgets, services
              │
              ├── GET  /api/peer/snapshot ──► peer ai-space ── its own apps …
              └── forwarded chat / embed / icon ──►   (loopback, published on a tunnel hostname)
```

Rules that follow from the existing design and stay true:

- **An app lives on exactly one machine.** Its directory, repository, data, tasks, storage and notifications are on that machine. The hub never provisions, schedules or stores anything for a peer app.
- **Scheduler, storage and notify stay local.** A peer runs its own; the hub's Tasks drawer shows the hub's tasks. Peer tasks are a later addition (see Later).
- **The peer's own panel keeps working.** A peer is a complete ai-space with its own web UI on loopback; being listed by a hub adds nothing to it but one group of routes.
- **One level.** A peer's snapshot contains its local apps only, never the apps of its own peers. Two hubs listing each other see each other's local apps and nothing more; no cycles.
- **Be honest.** A peer that does not answer is shown as down, with the time of the last snapshot; its apps stay on the panel, muted, never silently dropped and never shown as healthy.

## Naming

Names are per machine, so `media` on one machine and `media` on another are different apps. On the hub, a peer app is addressed by `<peer>/<app>`, an agent by `<peer>/<app>/<agent>`, a widget by `<peer>/<app>/<widget>`. Local apps keep their bare names; `<peer>` is a reserved first segment. Peer names follow the app-name rule (`[a-z0-9][a-z0-9._-]*`) and may not equal a local app name; the hub refuses to boot on a collision, since a tile called `david` would then be ambiguous.

The prefix is a display and layout key, not a route parameter: app names cannot contain `/` and the panel routes are shaped `/api/apps/:app`, so peer routes get their own prefix (below) and views carry a `peer` field next to the bare `name`. Every app view now has an `id` (the name, or `<peer>/<name>`), which is what the layout order and the hidden set hold. The web UI names the peer in the tile's hover card and uses `peer` to pick the route base.

## Configuration

Hub side, in `<workspace>/.env`, the same pattern as notify channels (`SPACE_NOTIFY_<NAME>`):

```
# Peers: other ai-space machines whose panel this one merges. NAME lowercased is the peer name.
SPACE_PEER_DAVID=https://space-david.example.com
SPACE_PEER_DAVID_TOKEN=<the peer's SPACE_HUB_TOKEN>
# Optional: extra request headers, for an access layer in front of the peer ("Name: value; Name: value").
# SPACE_PEER_DAVID_HEADERS=CF-Access-Client-Id: …; CF-Access-Client-Secret: …
# Optional: how often the hub refreshes the snapshot; default 30s, minimum 10s.
# SPACE_PEER_DAVID_REFRESH=30s
```

Peer side, in its own `.env`:

```
# Token a hub must present on /api/peer/*. Empty = those routes are absent.
SPACE_HUB_TOKEN=<random, 32+ bytes>
# What this space calls itself in the snapshot; default: the hostname.
SPACE_NAME=david
```

A peer is reachable the way its panel is: ai-space binds loopback, and the operator publishes the port on a hostname of the machine's tunnel. If an access layer sits on that hostname it either exempts `/api/peer/*` (the bearer token is the check there) or the hub sends the layer's credentials through `_HEADERS`. Publishing a peer on a plain public port is not supported: the peer routes are a bearer check, not an access layer.

A malformed peer line is reported at boot and skipped; the others load. A peer named like a local app stops the boot with a message.

## Peer side: `/api/peer/*`

Present only when `SPACE_HUB_TOKEN` is set; every route requires `Authorization: Bearer <token>`, and a wrong or missing token is a bare 401. The routes mirror the panel and agent routes the browser already uses, with the same handlers behind a token check, plus one snapshot:

| Route | Mirrors | Notes |
| --- | --- | --- |
| `GET /api/peer/snapshot` | `/api/apps`, `/api/services`, `/api/widgets`, `/api/agents` | One call: `{ ok, name, apps, services, widgets, agents, asOf }`. Apps are the peer's visible ones (its own hidden set and `archived` applied, `manifestOnly` and `url` included), agents and widgets likewise, widgets with their current items payload, services with health. The space agent (`space/assistant`) is not included: the hub has its own. |
| `GET /api/peer/apps/:app/icon` | `/api/apps/:app/icon` | Icon files from the app directory. |
| `GET /api/peer/apps/:app/appcolor` | `/api/panel/appcolor?app=` | |
| `GET /api/peer/agents/:app/:agent/avatar` | `/api/agents/:app/:agent/avatar` | |
| `GET /api/peer/widgets/:app/:name/embed` | `/api/widgets/:app/:name/embed` | The proxied embed page, `?theme=` passed through. |
| `POST /api/peer/agents/:app/:agent/chat` | `/api/agents/:app/:agent/chat` | The same body, the same SSE stream. Sessions are recorded on the peer. |
| `GET /api/peer/agents/:app/:agent/sessions[/:sid]` | `/api/agents/:app/:agent/sessions[/:sid]` | |

Nothing under `/api/peer/` mutates the peer: no create, no hide, no layout, no tasks, no storage, no notify. The hub's operator changes a peer app on the peer, the same way as today.

`name` in the snapshot is what the peer calls itself (`SPACE_NAME`); the hub ignores it for addressing (the hub's `SPACE_PEER_<NAME>` key is the name) and reports it, so a misconfigured pair is visible.

## Hub side

Module `src/space/peers/`:

| File | Holds |
| --- | --- |
| `config.ts` | `SPACE_PEER_*` parsing: name, URL, token, extra headers, refresh. |
| `client.ts` | One client per peer: `refresh()` on its own timer with the last good snapshot kept, `health()`, `forward(req, path)` for the proxied routes. Timeouts: 8 s for a snapshot, none for a chat stream (it stays open as long as the peer's does; the browser leaving aborts it), 8 s for the other forwards. |
| `store.ts` | The last good snapshot per peer in `space.db` (`peer_snapshots`), so a hub restart while a peer is down still lists its apps, muted. A peer dropped from `.env` loses its row at boot. |
| `merge.ts` | Turns a snapshot into hub views: prefixes ids, sets `peer`, rewrites icon, avatar and embed routes to the hub's proxy, applies the hub's hidden set, marks stale entries. |
| `hub.ts` | Every configured peer and the merged lists the panel appends. |
| `serve.ts` | The peer side (`/api/peer/*`). |
| `api.ts` | `GET /api/peers`, the hub-side hide, and the `/api/peers/:peer/*` proxy routes. |

What changed in the existing modules:

- **Views** (`panel/view.ts`, `panel/widgets.ts`): `AppView` gained `id`; `AppView`, `AgentView`, `WidgetView` and `ServiceView` gained an optional `peer`, apps and widgets an optional `stale`. Ids of peer entries carry the prefix (`david/media`, `david/media/assistant`, `david/media/latest`); `name` and `app` stay the bare names so the web UI can build peer routes from `peer` plus `name`. `icon`, `avatar` and `appIcon` of peer entries are the hub's proxy routes when they were file routes on the peer, and unchanged when they are emoji or absolute URLs. A peer app is never `manifestOnly` on the hub: it cannot be deleted from there.
- **Lists** (`panel/api.ts`, `agents/api.ts`): `GET /api/apps`, `/api/services`, `/api/widgets`, `/api/agents` append the merged peer entries after the local ones, then apply the hub's layout order (`orderBy` puts unlisted local entries before unlisted peer entries) and hidden set. The hub's `hidden` and `order` lists take the prefixed ids, so the operator can hide or reorder a peer app on the hub without touching the peer; `PATCH /api/peers/:peer/apps/:app { hidden }` does the hiding and only touches `panel_kv`. `?all=1` includes hub-hidden peer apps.
- **`GET /api/services`** carries a second list, `peers`: one entry per peer with `health` (`ok` when the last refresh succeeded within two refresh periods, `down` otherwise), `asOf`, `error`, `stale` and counts. `GET /api/peers` returns the same plus `duplicates`.
- **Widgets**: items widgets come with their payload in the snapshot, so the hub fetches nothing per widget; the peer's cache and `refresh` apply, the hub's snapshot refresh adds at most one period of delay. Embed widgets load through `/api/peers/:peer/widgets/:app/:name/embed`, which streams the peer's proxied page; the iframe sandbox is the same.
- **Chat** (`web/Chat.tsx`): the route base becomes `/api/peers/<peer>/agents/<app>/<agent>` when the agent has a `peer`, else the local one. Everything else is identical: the SSE events, `sessionId`, model and permission mode are the peer's. The hub records nothing in its `chat_sessions` for peer agents; the sessions list is forwarded.
- **Create and delete**: unchanged and local. A peer app cannot be created or deleted from the hub.

Proxy routes on the hub, all under `/api/peers/:peer/`, forward to the peer's `/api/peer/` with the bearer and extra headers added and the response streamed back as is (status, `content-type`, body). They accept only the paths in the table above; anything else under `/api/peers/` is 404 on the hub without a call to the peer.

## Failure and staleness

| Situation | What the panel shows |
| --- | --- |
| Peer answers | Its entries, live health, widget items with the peer's `asOf`. |
| Peer times out or errors | The last good snapshot, apps and widgets muted (`stale`), services `unknown`, the peer `down` with the last `asOf` and the error text; chat, embed and icons on those entries fail with 502 and the error, not a hub guess. |
| No good snapshot ever (new peer, wrong token) | The peer only, `down`, with the error (`token rejected` for a 401). Nothing invented. |
| Peer removed from `.env` | Its entries disappear on the next boot; its layout keys stay in `panel_kv` harmlessly, like a deleted app's. Its `peer_snapshots` row is deleted at boot. |
| Hub restarted while a peer is down | The stored snapshot, `stale` and `down`, until the first refresh succeeds. |

A snapshot is refreshed in the background on its own timer, never on a browser request, so a slow peer costs the panel nothing; a request always reads the cache.

## Trust boundary

The hub's panel routes carry no token (see [panel.md](panel.md)); the peer routes are the first bearer-guarded read surface, because they are meant to cross machines. What the token grants is exactly what the peer's own panel grants through its tunnel: read the app list, load pages and icons, and open a chat, including with `bypassPermissions`, which is a shell on the peer as the peer's user. The hub therefore holds, in its `.env`, a credential worth a shell on every peer; treat the hub's workspace accordingly. A peer that wants to limit this sets no `SPACE_HUB_TOKEN` and is listed on the hub as a link app instead.

Chat forwarding passes the request body through unchanged, so the hub's access layer decides who may chat, and the peer's token check decides which machine may ask. Neither side logs message text.

## Web UI

- Tile: looks like a local one; the hover card says "On <peer>", and while the peer is down the tile is muted and the card says so.
- Agents list: peer agents after local ones, same hover-card line.
- Widgets: a peer chip in the card head; muted while stale.
- Settings: a Peers section above Services when at least one peer is configured, one row per peer (name, health, snapshot age when down; the tooltip has the URL, counts and the error), then the Services rows with a peer chip on remote ones.
- Edit mode: hide works on peer entries (hub-side), delete is not offered.

## Migration from link apps

A link app on the hub whose `url` equals a peer app's `url` is superseded. `GET /api/peers` reports these under `duplicates`; the operator deletes the link apps from the panel. The hub does not delete them itself: a link app may be there on purpose (a different title, a public page of an app whose service is elsewhere).

## Deploying a peer

1. Install ai-space on the second machine as a user unit (`deploy/install.sh`), workspace `~/.ai-space`, apps under `apps/` as on any machine.
2. In its `.env`: `SPACE_HUB_TOKEN` (random) and `SPACE_NAME`.
3. Publish its port on a hostname of the machine's tunnel; exempt `/api/peer/*` from the access layer or note the layer's service credentials.
4. In the hub's `.env`: `SPACE_PEER_<NAME>`, `_TOKEN` and, if needed, `_HEADERS`; restart the hub. `GET /api/peers` shows `ok` and the counts, or the error.
5. Delete the link apps listed under `duplicates`.

## Later

- **Peer tasks**: `GET /api/peer/tasks` and `/api/peer/tasks/:id/runs`, read-only, so the Tasks drawer groups tasks by machine. Running or toggling a task stays on the machine that owns it.
- **Peer storage inventory** in the settings, read-only.
- **Peer notifications**: none needed; each machine notifies through its own channels.
- **A peer behind no tunnel** (a laptop): a reverse connection the peer opens to the hub. Out of scope until a machine needs it.

## Without a peer

An app that runs on a machine with no ai-space, or on a peer that sets no `SPACE_HUB_TOKEN`, is registered on the hub as a manifest-only link app (`apps/<name>/space.yaml` with identity fields and `url`; see [panel.md](panel.md) and the `link` mode of the `space-app` skill). It gets a tile and, with a public `source` URL, widgets; no health and no chat.
