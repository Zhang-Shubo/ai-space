# Panel design

The panel is the web entry of an ai-space: a launcher that lists the apps, opens a chat with any agent, shows the widgets apps feed it, and lets the operator add, hide and arrange things. It is served by ai-space itself, on the same loopback port as the Space API, and reads everything it shows from the apps' manifests.

Status: implemented. Service supervision (starting and restarting `service.command`) and skill mounting for agent sessions are not part of this stage; the [app spec](app-spec.md) status table says what is missing.

## Why inside ai-space

The panel started life as a separate process that read a registry of markdown files: one file per app with a name, an icon, a repository, a one-line summary and, for some, a widget endpoint. It worked, and it taught three lessons that shaped this design:

- **The registry drifts from the apps.** A file that lives next to the panel, not next to the app, is edited when someone remembers. Widget endpoints were "hand-written into the registry and lost when the entry was recreated". The app spec already says the manifest is the registration; the panel only had to read it.
- **Private overlays are a workaround for a missing workspace.** Public entries in one directory, private ones in another, tombstones to hide a public entry: all of it existed because the registry was a shared repository. In ai-space the workspace is the operator's own; there is one list.
- **Chat, widgets and layout are Space services.** Spawning a runtime, caching widget payloads, remembering an order: none of it belongs to an app, and a second process next to ai-space would have to duplicate app discovery and the workspace layout.

So the panel is a set of routes in ai-space's `Bun.serve`, a React page bundled from `src/web/` by Bun's HTML import, and two small tables in ai-space's database.

## What the panel shows

| Section | Source | Notes |
| --- | --- | --- |
| Apps | every registered manifest with `status` other than `archived`, minus the hidden set | Tile: `icon`, `title`, a health dot when the app declares `service.health`. Click opens `url`, else the repository. Hover shows the description and status. |
| Agents | `agents:` of every visible app, plus the space agent | Tile shows the avatar and title; click opens the chat drawer on that agent. |
| Widgets | `widgets:` of every visible app | `items` cards render the list in the house style; `embed` cards load the app's page in a sandboxed iframe through ai-space. |

The **space agent** (`space/assistant`) is the default chat identity: a claude session in the workspace root with a short built-in prompt. It is the one exception to "nothing exists outside an app", on the same footing as the Space services themselves.

## Manifest-only apps

The launcher must be able to show things that are not ai-space services: a page, a tool on another machine, a repository. Rather than a second kind of entry, these are ordinary apps whose directory holds only a manifest:

```
<workspace>/apps/docs/
└── space.yaml       spec, name, title, description, icon, url
```

ai-space treats them like any app (they can even declare widgets with a full `source` URL, or agents). The panel creates them when the operator adds a link, and it is the only kind of app the panel deletes: an app with code or a service is hidden instead, and its directory is never touched. A manifest-only directory is not a git repository; it is restored from a workspace backup, not from a clone.

## Adding an app from a link

Edit mode has an "Add" tile that takes one link. The panel asks the claude runtime to read the page (`claude -p … --allowedTools WebFetch`) and answer with a JSON object of identity fields, validates the answer, writes `apps/<name>/space.yaml`, and syncs the new directory (storage, scheduler, registry) like a boot would. The link itself becomes `url` when the answer names none. Fields can also be posted directly, which is what a script or a skill does.

## Layout and state

Two tables in `space.db`, both panel-owned:

- `panel_kv` holds the layout: `{ order: { apps, agents, widgets }, hidden }`. Order lists are names (apps) or ids (`app/name` for agents and widgets); names missing from a list follow it alphabetically. `hidden` is the set of apps the panel does not show; they stay registered and scheduled.
- `chat_sessions` keeps the last ten sessions per agent (`agent`, `sid`, `title`, `ts`). A resumed session gets a new id from the runtime; the previous row is replaced so a conversation stays one entry.

Nothing panel-related is written into an app directory or into the workspace as loose files.

## Chat

`POST /api/agents/:app/:agent/chat` runs one turn: ai-space spawns `claude -p <message> --output-format stream-json` in the agent's working directory with the identity from the manifest (`--append-system-prompt` from the prompt file plus the app title, description and `AGENTS.md`; `--allowedTools` from `tools`; `--model` from the request, the manifest, then `SPACE_CHAT_MODEL`) and streams the events back as server-sent events. Multi-turn continuity is `--resume <sid>`. The browser can pick a write tier (`acceptEdits`, `bypassPermissions`, `plan`); the default is the headless read-only behaviour. `SPACE_CHAT_ARGS` appends operator-chosen arguments to every run.

Transcripts are read back from the CLI's own store (`~/.claude/projects/<cwd>/<sid>.jsonl`), so restoring a past session costs no extra storage. Only the `claude` runtime is supported for chat; a `codex` agent answers 501 until its event format is adapted.

## Widgets

`GET /api/widgets` fetches every `kind: items` source through ai-space, caches each payload for the widget's `refresh`, and returns at most twenty items with only the contract fields (`text`, `url`, `time`). A failing source yields `{ ok: false, error }` and the card shows the error as is. Sources are resolved server-side: a path is joined to `http://127.0.0.1:<service.port>`, a full URL is used unchanged; neither reaches the browser. `kind: embed` widgets are proxied at `GET /api/widgets/:app/:name/embed?theme=` because the browser cannot reach loopback; the page must be self-contained (inline assets or absolute public URLs).

## Health

Service supervision is not implemented yet, so the panel probes `GET 127.0.0.1:<port><service.health>` when it lists apps, caches the result for fifteen seconds, and shows a green or red dot. Apps without `service.health` show no dot.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` and the PWA files | the web UI |
| `GET /api/apps`, `GET /api/apps/:app` | app views (`?all=1` includes hidden apps) |
| `POST /api/apps` | create a manifest-only app from `{ link }` or identity fields |
| `PATCH /api/apps/:app` | `{ hidden }` |
| `DELETE /api/apps/:app` | manifest-only apps only |
| `GET /api/apps/:app/icon`, `GET /api/agents/:app/:agent/avatar` | icon files from the app directory; paths cannot escape it |
| `GET /api/widgets`, `GET /api/widgets/:app/:name/embed` | widget payloads and embed pages |
| `GET`/`PUT /api/panel/layout` | order and hidden set |
| `GET /api/panel/appcolor?app=` | the app page's `theme-color`, for the phone shell |
| `GET /api/agents` | every agent the panel lists |
| `POST /api/agents/:app/:agent/chat` | one chat turn, SSE |
| `GET /api/agents/:app/:agent/sessions[/:sid]` | recent sessions, restored transcript |

## Trust boundary

These routes carry no bearer token. The browser cannot hold `SPACE_API_TOKEN`, and the panel is reached the way the previous panel was: through the operator's tunnel and access layer from outside, through loopback on the machine. The machine-side routes (tasks, storage, notify) keep the token. Consequences to be aware of:

- Anyone who passes the access layer can open a chat with `bypassPermissions`, which is a shell on the machine with the operator's runtime login. This is the same exposure as before, now written down.
- Anything on the machine that can reach loopback can create or delete manifest-only apps and change the layout. Command tasks run as the same user anyway.

An operator who wants a second factor puts it in front of the tunnel, not in ai-space.

## Module layout

```
src/space/panel/    registry.ts (registered manifests), layout.ts (panel_kv), health.ts,
                    widgets.ts (feed + cache), view.ts (API shapes), links.ts (manifest-only apps),
                    api.ts (routes)
src/space/agents/   runtime.ts (claude process + SSE), sessions.ts (chat_sessions),
                    transcript.ts, api.ts (routes, space agent)
src/web/            index.html, main.tsx, App.tsx, Chat.tsx, Pet.tsx, styles.css, api.ts,
                    routes.ts (HTML import + public files), public/ (PWA shell, pet sprite)
```

`bun run dev` starts ai-space with `SPACE_DEV=1`, which turns on Bun's dev server for the page (hot reload); the default is one bundle at boot.

## Migrating from a registry-based panel

1. For every app that already is an ai-space app, fill in the identity fields (`title`, `description`, `icon`, `url`) and, where the registry had one, the `widgets` entry.
2. For every other registry entry, create `apps/<name>/space.yaml` with the identity fields and copy its icon file next to it as `icon.svg`. When that app later moves into the workspace, the directory is replaced by the clone.
3. Registry agents move into the `agents:` section of the app they belong to, their prompt into `agents/<name>.md`; the generic default agent is the space agent and needs no entry.
4. Import the old order into the layout: `PUT /api/panel/layout` with the names in order.
5. Point the tunnel at ai-space's port and stop the old panel; keep it installed until the new one has been used for a while.

## Failure modes considered

- A manifest fails validation: the app is skipped with a log line and the panel does not list it, same as the scheduler. Nothing partial.
- A widget source is slow or down: eight-second timeout, error shown on the card, next attempt after `refresh`.
- The runtime is missing or exits non-zero: the SSE stream ends with an `error` event carrying the last lines of stderr, then `done`.
- The browser disconnects mid-turn: the response stream is cancelled and the runtime process is killed.
- Two people reorder at once: last write wins; the layout is small enough that this is acceptable.
- An icon path points outside the app directory: 404.
