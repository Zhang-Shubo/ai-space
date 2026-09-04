# App specification

This document is the contract between ai-space and the apps that run inside it. It says what an app is, how it is laid out, what it declares in `space.yaml`, and what ai-space promises in return. Everything an app author (human or agent) needs to build a conforming app is here; the service design notes ([scheduler](scheduler.md), [storage](storage.md), [notify](notify.md)) explain how ai-space implements its side.

Spec version: `1`. An app states the version it targets with `spec: 1` at the top of `space.yaml`. Breaking changes bump the number; ai-space keeps accepting older versions for at least one release.

Status: the `tasks`, `storage` and `notify` sections, the workspace layout and the `space.env` hand-over are implemented. `agents`, `widgets`, `skills`, the JSON Schema, `validate` and `new-app` are specified here first and implemented next; the [status table](#implementation-status) at the end tracks it.

## What an app is

An app is the unit of ownership in ai-space. It is one directory, one git repository, one `space.yaml`, and it owns everything it contributes to the space:

- a **service** (optional): the app's own long-running process or HTTP server;
- **agents** (zero or more): chat identities backed by a Claude Code or Codex session, configured with a prompt and a set of skills;
- **widgets** (zero or more): cards the home panel renders, fed by the app;
- **skills** (zero or more): project skills shipped in the repository, used by the app's agents;
- **tasks**: scheduled work the scheduler runs on the app's behalf;
- **storage**: databases and blob stores ai-space provisions for the app;
- **notify**: the chat channels the app may send notifications to.

The model is the Android one: the app declares its widgets and agents, ships them in its own repository, and the space's web UI is the launcher that lists, places and routes them. Nothing in the space exists outside an app except the space's own services.

Six rules apply to every app:

1. **One app, one repository.** The directory under `<workspace>/apps/` is a complete git repository that can be cloned, deployed and retired on its own. Apps never share files; shared things move down into ai-space (a Space service or a shared skill).
2. **One name everywhere.** The app name is lowercase kebab-case (`[a-z0-9][a-z0-9._-]*`) and is the directory name, the repository name, the `name` in `space.yaml`, the systemd unit name and the data directory name. Pick it before creating anything; renaming touches all five.
3. **Configuration is environment.** Secrets and machine-specific values come from `<workspace>/.env` (shared) and the app's own `.env` (ignored by git). The repository only ever holds `.env.example`. ai-space hands provisioned values over through `space.env`.
4. **Listen on loopback.** A service binds `127.0.0.1` on the port given by `PORT`. Exposure to the outside is the space's job (tunnel, auth), never the app's.
5. **Declare, do not integrate.** Everything the app wants from ai-space is declared in `space.yaml`. The app does not import ai-space code and does not need to be written in TypeScript.
6. **Be honest.** Data an app cannot obtain is left empty or marked missing, never invented. Every record can answer "where from, when". History is appended, not rewritten. Widgets and agents inherit these three rules.

## Directory layout

```
<workspace>/apps/<name>/
├── space.yaml            the manifest; the only file ai-space reads
├── README.md             for users: what it is, how to use it
├── AGENTS.md             for agents and new maintainers: read first, then touch code
├── .env.example          every variable the app reads, with defaults, no real values
├── .gitignore            ignores .env, .env.*, data/, *.db (template below)
├── icon.svg              app icon shown by the panel (64x64 viewBox, rounded square)
├── src/                  the service, if any
├── agents/               one prompt file per agent (agents/<agent>.md)
├── widgets/              widget templates or static assets, if any
├── skills/               project skills, one directory each (skills/<skill>/SKILL.md)
└── prompts/              prompt files for scheduled agent tasks
```

Only `space.yaml` is mandatory. The other paths are conventions the manifest refers to; an app may point at different paths but should not.

Runtime state never lives in the app directory. ai-space keeps it under `<workspace>/data/<name>/`:

```
<workspace>/data/<name>/
├── main.db               provisioned SQLite database(s)
├── blobs/                provisioned filesystem blob store
└── space.env             generated variables the app loads (never edited by hand)
```

## The manifest: `space.yaml`

The manifest is a YAML mapping. Parsing is strict: an unknown top-level key, a wrong type or a bad value rejects the whole app, so nothing partially applies. `${VAR}` and `${VAR:-default}` placeholders in strings are resolved from `<workspace>/.env` and the process environment at sync time.

### Top level

```yaml
spec: 1
name: my-app                       # required; must match the directory name
title: My App                      # display name; default: name
description: One sentence saying what the app does.
icon: icon.svg                     # path in the repo or an emoji; default: icon.svg if present
status: active                     # active (default) | paused | archived
repo: https://github.com/<owner>/my-app.git   # informative; set by new-app
```

| Key | Type | Notes |
| --- | --- | --- |
| `spec` | int | Spec version. Missing means `1` while `1` is the only version. |
| `name` | string | App name, rule 2 above. Missing means the directory name. |
| `title` | string | Shown on the panel. |
| `description` | string | One sentence, shown on the panel card and to agents. |
| `icon` | string | Repository path to an SVG or PNG, or a single emoji. |
| `status` | enum | `paused` keeps the app listed but stops its tasks and service; `archived` hides it and stops everything. Storage is never dropped by a status change. |
| `repo` | string | The origin URL. |

Sections: `service`, `agents`, `widgets`, `skills`, `tasks`, `storage`, `notify`. Each is optional.

### `service`

The app's own process, if it has one. ai-space starts it, restarts it on failure, forwards its logs and checks its health.

```yaml
service:
  command: bun src/index.ts        # run from the app directory
  port: 8710                       # handed over as PORT; must be unique in the workspace
  health: /healthz                 # GET on 127.0.0.1:<port>; 200 = healthy; default: none
  env:                             # extra static variables; secrets go through ${VAR}
    LOG_LEVEL: info
```

Contract for the process:

- It reads `PORT`, binds `127.0.0.1:${PORT}` and nothing else.
- Its environment is, in increasing precedence: the app's `.env`, `<workspace>/data/<name>/space.env`, `service.env`, then the values ai-space sets (`PORT`, `SPACE_APP`, `SPACE_APP_DIR`, `SPACE_APP_DATA_DIR`, `SPACE_API_URL`).
- It logs to stdout and stderr; ai-space collects them under `<workspace>/logs/<name>/`.
- It answers `GET <health>` with 200 when it can serve requests. The panel shows the app as down otherwise.
- It exits on `SIGTERM` within 10 seconds.

Apps without a service (a pure agent app, a widget fed by a task) omit the section.

### `agents`

An agent is a chat identity: a runtime session started in the app's directory with a system prompt, a tool allow-list and a set of skills. Declaring one costs no code. The panel lists every agent of every app and opens a chat with any of them.

```yaml
agents:
  - name: assistant                # unique within the app; shown as my-app/assistant
    title: Assistant
    description: Answers questions about this app's data and runs its maintenance.
    avatar: agents/assistant.svg   # default: the app icon
    runtime: claude                # claude (default) | codex
    model: sonnet                  # runtime-specific model name; default: the runtime's default
    prompt: agents/assistant.md    # system prompt file, relative to the app directory
    cwd: .                         # session working directory, relative to the app directory
    tools:                         # runtime tool allow-list; default: read-only tools
      - Read
      - Bash(bun *)
    skills:
      - ./skills                   # every skill directory under skills/
      - ./skills/import-notes      # or a single one
      - space:keep                 # a shared skill ai-space provides
    memory: shared                 # shared (default: the workspace memory) | app | none
```

| Key | Notes |
| --- | --- |
| `name` | `[a-z0-9][a-z0-9-]*`. The agent's id is `<app>/<name>`. |
| `runtime` | Which CLI backs the session. ai-space starts `claude` or `codex` with the prompt, tools and skills mounted; the app never spawns the runtime itself. |
| `prompt` | The system prompt. The app's `AGENTS.md` and `description` are appended so every agent knows the app it belongs to. |
| `tools` | Passed to the runtime as its allow-list. Server-side only: the chat client cannot widen it. |
| `skills` | App-local paths (`./...`) or shared skills (`space:<name>`). See [Skills](#skills). |
| `memory` | Which long-term memory directory the session mounts. |

Scheduled agent runs are not agents. They are tasks with an `agent` target (see [`tasks`](#tasks)); a task may reuse a declared agent's configuration with `run: { agent: { use: assistant, prompt: prompts/daily.md } }`.

### `widgets`

A widget is a card on the home panel that belongs to one app. Two forms exist. The `items` form hands the panel a list and the panel renders it in the house style, so every widget looks the same and works on every screen. The `embed` form gives the app a rectangle to draw in when a list is not enough.

```yaml
widgets:
  - name: latest                   # unique within the app
    title: My App · Latest         # card title; default: app title
    kind: items                    # items (default) | embed
    source: /api/widget            # path on the app's service, or a full URL
    link: /#latest                 # "view all" target, relative to the app's public URL; default: the app
    size: 1x1                      # columns x rows on the panel grid: 1x1 (default), 2x1, 2x2
    refresh: 60s                   # how often the panel re-fetches; default 60s, minimum 15s
```

Contract for `kind: items`. `GET <source>` returns:

```json
{ "ok": true, "items": [ { "text": "…", "url": "https://…", "time": "2026-09-04T09:00:00Z" } ] }
```

`text` is required; `url` and `time` (ISO 8601) are optional and the panel renders relative time. On failure the app returns `{ "ok": false, "error": "…" }` and the panel shows the error as is. The panel fetches through ai-space (`/api/widgets`), caches for `refresh`, and only ever calls URLs that a manifest declares, so `source` may be a loopback address and is never sent to the browser.

Contract for `kind: embed`. `source` is a page the app serves; the panel loads it in a sandboxed iframe of the declared size, in the viewer's theme (the page receives `?theme=light|dark`). The page must work without cookies and without a public origin.

### `skills`

Skills are instructions a runtime loads for a session. They follow the Claude Code skill format: one directory per skill with a `SKILL.md` whose frontmatter carries `name`, `description` (including the trigger phrases, in whatever language the user speaks), optional `argument-hint`, `allowed-tools` and `user-invocable`.

Two homes:

- **App skills** live in the app repository under `skills/<skill>/SKILL.md`. They ship with the app and are private to it. Declare them on the agents that use them; the `skills:` top-level section is only needed to expose them for scheduled agent tasks or to give them a title.
- **Shared skills** live in ai-space under `skills/<skill>/` and are referenced as `space:<skill>`. A skill becomes shared when a second app needs it; until then it stays in the app.

```yaml
skills:
  - path: skills/import-notes      # optional listing; agents reference skills directly
```

When ai-space starts a session it mounts the union of the agent's skills into the runtime's skill path (for Claude Code, a `.claude/skills/` directory inside the session's working directory, populated with links). Apps do not commit `.claude/`; the runtime layout is ai-space's concern, so switching runtimes changes nothing in the app.

### `tasks`

Scheduled work. The full reference is in [scheduler.md](scheduler.md); the shape is:

```yaml
tasks:
  - name: refresh
    every: 30m
    timeout: 10m
    run:
      http: { method: POST, url: "http://127.0.0.1:${PORT}/jobs/refresh" }
  - name: daily-digest
    schedule: "30 14 * * *"
    timezone: UTC
    run:
      agent: { runtime: claude, prompt: prompts/daily-digest.md, model: sonnet }
  - name: backup
    schedule: "0 3 * * *"
    run:
      command: "bun scripts/backup.ts"
```

Exactly one of `at` / `every` / `schedule` and exactly one of `run.http` / `run.command` / `run.agent` per task. Commands and agent runs execute in the app directory with the app's environment (`.env` and `space.env` merged). Real cron expressions live only here, never in a machine's crontab.

### `storage`

Databases and blob stores. The full reference is in [storage.md](storage.md); the shape is:

```yaml
storage:
  database: sqlite                 # sqlite (default) | postgres; or a databases: list
  blobs: file                      # none (default) | file | s3
  backup:
    schedule: "0 3 * * *"
    keep: { daily: 7, weekly: 4, monthly: 6 }
```

ai-space provisions what is declared and writes `DATABASE_URL`, `BLOB_URL`, `SPACE_APP_DATA_DIR` and, for S3, the `S3_*` credentials into `space.env`. Apps read the URL and connect with whatever client their language has; SQL written against the portable subset in storage.md runs on both backends.

### `notify`

Outbound notifications to chat apps (Telegram, Discord, Slack, Feishu, DingTalk, WeCom, Bark, ntfy, a generic webhook). The full reference is in [notify.md](notify.md). Channels and their credentials are configured once by the operator in `<workspace>/.env`; the app only says which of them it may use:

```yaml
notify:
  default: ops                     # channel used when a request names none; default: default
  channels: [ops, trades]          # channels this app may name; default: [default]
  title: My App                    # tag in the first line of every message; default: the app title
  window: 10m                      # default dedup window for keyed messages; default: 10m
```

The app sends one HTTP request and never touches channel markup or credentials:

```
POST ${SPACE_API_URL}/api/notify
Authorization: Bearer ${SPACE_APP_TOKEN}
{ "level": "alert", "title": "Feed stalled", "text": "No items for 3 hours.", "url": "https://…", "key": "feed-stalled" }
```

`level` is `info` (default), `success`, `warn`, `alert` or `report`; `text` is plain text; `image` is optional. The call returns as soon as the message is queued. Naming a channel outside `channels` is a 400; sending when no channel is configured succeeds and is recorded as skipped, so an app never fails because notifications are not set up. Shell tasks use `bun src/index.ts notify`, agents use the shared skill `space:notify`. Tasks can ask the scheduler to notify on failure or success with `notify: { when: [error, ok], channel: ops }` and no app code at all.

## Repository

Every app is a git repository from the first minute, created by `new-app` (below) or by hand following the same steps:

1. The directory is initialised with the template and committed.
2. If GitHub is configured, a **private** repository named after the app is created under the configured owner and set as `origin`, and the first commit is pushed. Nothing else changes when GitHub is not configured: the app is complete locally, and `origin` can be added later.
3. `repo:` in `space.yaml` records the origin URL.

GitHub configuration lives in `<workspace>/.env` only:

```
# GitHub: set to create a private repository for every new app. Empty = local only.
# GH_TOKEN=                      personal access token with repo scope; gh reads this name natively
# SPACE_GITHUB_OWNER=            user or organisation that owns new repositories
# SPACE_GITHUB_VISIBILITY=private
```

The token reaches `gh` only through the environment of the child process ai-space spawns. It is never written into the app directory, `space.yaml`, `space.env` or a log line. `new-app --no-github` skips the step for one app.

What a repository must never contain: `.env` and any `.env.*` except `.env.example`, `space.env`, `data/`, database files, tokens, or personal data. The template `.gitignore` is:

```
.DS_Store
node_modules/
.venv/
.env
.env.*
!.env.example
data/
*.db
*.db-wal
*.db-shm
*.log
```

Two documents ship with every app. `README.md` is for users. `AGENTS.md` is for agents and new maintainers and follows a fixed skeleton so any agent knows where to look: rules, stack and runtime model, directory map with the core files marked, conventions, commands, environment variables, deployment, known pitfalls. The known-pitfalls section is the one that pays for itself; record every trap the moment it is hit.

Commit messages follow Conventional Commits, as in ai-space itself.

## Lifecycle

| Step | Command | What happens |
| --- | --- | --- |
| Create | `bun run new-app <name> [--no-github]` | Copies `templates/app/`, fills in the name, `git init` and first commit, private GitHub repository when configured, registers nothing else: the directory under `apps/` is the registration. |
| Validate | `bun run validate [<dir>]` | Parses `space.yaml` against the schema and the semantic rules (unique ports, referenced files exist, placeholders resolvable). Exit code 1 with one line per problem. |
| Sync | automatic on boot and on `POST /api/apps/sync` | Discovers every `apps/*/space.yaml`, provisions storage, registers tasks, starts services, publishes agents and widgets. Idempotent. |
| Pause / archive | edit `status:` and sync | Tasks and service stop; storage stays. |
| Remove | delete the directory and sync | Tasks are marked orphaned, the service stops, agents and widgets disappear. `<workspace>/data/<name>/` is kept until removed by hand. |

Sync rejects an app whose manifest fails validation and keeps the previous good state for that app; other apps are unaffected.

## What ai-space provides

Every conforming app can rely on these being present.

Environment, always:

| Variable | Meaning |
| --- | --- |
| `SPACE_APP` | The app name. |
| `SPACE_APP_DIR` | Absolute path of the app directory. |
| `SPACE_APP_DATA_DIR` | Absolute path of `<workspace>/data/<name>/`. |
| `SPACE_API_URL` | Base URL of the Space API, loopback. |
| `SPACE_APP_TOKEN` | Per-app bearer token for the Space API; identifies the app on `POST /api/notify`. Written to `space.env`. |
| `PORT` | For services: the declared port. |

Environment, when declared: `DATABASE_URL` (or `DATABASE_URL_<NAME>` for several), `BLOB_URL`, `S3_*`.

API, for apps and their agents:

| Route | Purpose |
| --- | --- |
| `GET /api/apps` | Every app with its status, agents and widgets. |
| `GET /api/tasks`, `POST /api/tasks/:id/run` | Inspect and trigger the app's own tasks. |
| `GET /api/widgets` | Every widget's latest payload (used by the panel). |
| `POST /api/agents/:app/:agent/chat` | Open or continue a chat session. |
| `POST /api/notify`, `GET /api/notifications?app` | Send a notification; read the app's own delivery history. |
| `GET /api/spec` | The spec version and JSON Schema this ai-space enforces. |

Mutating routes require the bearer token from `SPACE_API_TOKEN`, or the app's own `SPACE_APP_TOKEN` where the route acts on behalf of one app.

## Full example

```yaml
spec: 1
name: notes
title: Notes
description: Personal notes with an agent that files and searches them.
icon: icon.svg
repo: https://github.com/example/notes.git

service:
  command: bun src/index.ts
  port: 8710
  health: /healthz

agents:
  - name: librarian
    description: Files new notes, answers questions from the archive.
    prompt: agents/librarian.md
    tools: [Read, Grep, Bash(bun *)]
    skills: [./skills, space:keep]

widgets:
  - name: recent
    title: Notes · Recent
    source: /api/widget/recent
    link: /#recent
    size: 2x1
    refresh: 2m

tasks:
  - name: weekly-review
    schedule: "0 9 * * 1"
    timezone: Asia/Shanghai
    run:
      agent: { use: librarian, prompt: prompts/weekly-review.md }

storage:
  database: sqlite
  blobs: file
  backup:
    schedule: "0 3 * * *"
    keep: { daily: 7, weekly: 4 }

notify:
  channels: [default, reports]
```

## Implementation status

| Area | Status |
| --- | --- |
| Workspace layout, app discovery, `space.env` | Implemented (`src/space/workspace.ts`, `src/space/storage/`) |
| `tasks` | Implemented (`src/space/scheduler/`) |
| `storage` databases and blob hand-over | Implemented; managed blob API and backups pending |
| `notify`, `/api/notify`, `SPACE_APP_TOKEN` | Implemented (`src/space/notify/`, `skills/notify/`) |
| Top-level `spec`, `title`, `description`, `icon`, `status`, `repo` | Planned |
| `service` | Planned |
| `agents`, chat route | Planned |
| `widgets`, `/api/widgets` | Planned |
| `skills`, shared skills under `skills/` | Planned |
| JSON Schema (`schema/space.schema.json`), `validate`, `/api/spec` | Planned |
| `templates/app/`, `new-app`, GitHub repository creation | Planned |
