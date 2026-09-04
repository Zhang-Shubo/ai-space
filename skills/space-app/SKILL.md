---
name: space-app
description: Create a new ai-space app or change an existing one (identity, service, agents, widgets, tasks, storage, notify, status) by the app spec, then put it in the workspace and sync it. Use when a prompt asks to build, add, register, adopt, edit, pause, archive or remove an app, or to give an app an agent, a widget, a scheduled task, a database, a blob store or a notification channel. 当用户说"新建 app""创建 app""建个 app""把 XX 接入 ai-space""改 app""修改 app""给 XX 加个 agent / 小组件 / 定时任务 / 数据库""暂停 app""归档 app""下架 app"时触发。
argument-hint: "<name> [--link <url>] [--adopt <dir>] [--port <n>] [--no-github]"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git *), Bash(gh *), Bash(bun *), Bash(curl *), Bash(ssh *), Bash(scp *), Bash(rsync *), Bash(mkdir *), Bash(cp *), Bash(ls *), Bash(cat *), Bash(chmod *), Bash(systemctl *), Bash(journalctl *), Bash(ss *), Bash(lsof *)
user-invocable: true
---

# space-app

The contract is [docs/app-spec.md](../../docs/app-spec.md). This skill is the procedure that gets an app from an idea to a running, registered, verified entry in the workspace, and the procedure for changing one afterwards. Nothing here is machine-specific: hosts, ports, tokens and channels come from the workspace and the operator.

Two places you may be running:

- **on the space host**, in an operator session: the workspace is `${SPACE_HOME:-~/.ai-space}` and the Space API is `http://127.0.0.1:${SPACE_PORT:-8700}`;
- **on a development machine** with SSH access to the host: prefix host-side commands with `ssh <host>` and copy files with `scp` or `rsync`. Ask which host when it is not obvious.

Set these once and reuse them in every command below:

```bash
WS=${SPACE_HOME:-$HOME/.ai-space}
API=http://127.0.0.1:${SPACE_PORT:-8700}
TOKEN=$(grep -E '^SPACE_API_TOKEN=' "$WS/.env" | cut -d= -f2-)   # on the host
```

## 0. Decide the mode

| Mode | When | What is produced |
| --- | --- | --- |
| **link** | the operator wants a page, a tool elsewhere or a repository on the panel | `apps/<name>/space.yaml` with identity fields only (manifest-only app) |
| **create** | a new app with code: a service, agents, widgets, tasks | a new repository from `templates/`, deployed into `apps/<name>` |
| **adopt** | an existing project that should become an app | `space.yaml` and the service contract added to that repository |
| **edit** | anything about an existing app changes | the manifest (and code) changed in the repository, redeployed, resynced |

Collect what is missing before touching anything:

| Item | Rule |
| --- | --- |
| name | `[a-z0-9][a-z0-9._-]*`; directory = repository = `name:` = unit = data directory. Renaming later touches all five, so settle it first. |
| description | one sentence; goes on the panel card and into every agent's context |
| page or not | an app with a page declares `url:` and gets a tile; without `url` it has no tile, whatever else it declares |
| service or not | a process that listens gets `service:` (port, health); an agent-only or task-only app has none |
| icon | an SVG in the repository (64x64 viewBox, rounded square), an emoji, or an http(s) URL |

Do not invent values: a description you cannot write from the request is a question to the operator, not a guess.

## 1. Read the workspace first

```bash
curl -sS "$API/api/apps?all=1" | jq -r '.apps[] | [.name, .status, (.url // "-")] | @tsv'   # names already taken
curl -sS "$API/api/services"   | jq -r '.services[] | [.app, .port] | @tsv'                # ports already taken
grep -E '^SPACE_(NOTIFY_|S3_|PG_ADMIN_URL)' "$WS/.env" | cut -d= -f1                          # channels, S3, Postgres available
```

Pick a free port for a service. Declare only what the workspace can honour: `storage.blobs: s3` needs `SPACE_S3_*`, `storage.database: postgres` needs `SPACE_PG_ADMIN_URL`, a `notify.channels` entry needs a matching `SPACE_NOTIFY_<NAME>`. If the operator wants one that is not configured, say so and either configure it with them or leave the section out.

## 2. Link app

One request, no repository, no restart. Either hand the panel a link and let it read the page:

```bash
curl -sS -X POST "$API/api/apps" -H 'content-type: application/json' -d '{"link":"https://example.test/tool"}'
```

or post the identity fields directly (`name`, `title`, `description`, `icon` as emoji or URL, `url`, `repo`). The panel writes `apps/<name>/space.yaml` and syncs it. A link app cannot declare a service; if it later grows code, replace the directory with the clone (mode **adopt**) and restart.

An app that runs on another machine with its own ai-space does not need a link app: register that machine as a peer of this one (`SPACE_PEER_<NAME>` in the workspace `.env`, [docs/peers.md](../../docs/peers.md)) and its apps, agents, widgets and services appear here as `<peer>/<app>`, with chat forwarded. `GET /api/peers` lists link apps a peer makes redundant under `duplicates`; delete those.

To remove one: `curl -sS -X DELETE "$API/api/apps/<name>"`. This is the only kind of app the API deletes.

## 3. Create a code app

1. **Directory and template.** Create the project directory where the operator keeps projects (ask if unknown; never inside the ai-space checkout) and copy `templates/` from this skill into it: `space.yaml`, `README.md`, `AGENTS.md`, `env.example` (rename to `.env.example`), `gitignore` (rename to `.gitignore`), `icon.svg`, `src/index.ts`, `agents/assistant.md`, `deploy/app.service`, `deploy.sh`. Replace every `my-app` / `My App` / `8710` with the real name, title and port. Delete the sections the app does not need (`agents`, `widgets`, `tasks`, `storage`, `notify`); an empty section is worse than none.
2. **Service contract** (only if the app has a service): read `PORT`, bind `127.0.0.1` and nothing else, answer `GET /healthz` with 200, log to stdout, exit on `SIGTERM` within 10 seconds. The template does all of this; keep it when you replace the handler.
3. **Widget** (optional): `GET <source>` returns `{ ok: true, items: [{ text, url?, time? }] }`, at most twenty items, and `{ ok: false, error }` on failure. A path `source` needs a `service`; without one give a full URL.
4. **Agent** (optional): a prompt file per agent under `agents/`. Write the prompt self-contained (the app's `AGENTS.md` and description are appended automatically); keep `tools` read-only unless the operator wants writes, and make the prompt ask before any write; use `Bash(cmd *)` patterns, never bare `Bash`.
5. **Validate the manifest** from an ai-space checkout before deploying, so a rejected app never reaches the host:

   ```bash
   APP_DIR=/path/to/my-app bun -e 'import { loadManifest } from "./src/space/scheduler/manifest.ts"; const m = await loadManifest(process.env.APP_DIR!); console.log("ok", m.app)'
   ```

   Any error means the whole app would be skipped at sync; fix it here. This replaces `bun run validate` until that command exists.
6. **Repository.** `git init`, first commit with the template, then a private repository named after the app under the operator's GitHub owner (`gh repo create <name> --private --source . --push`) unless `--no-github`. Put the origin URL into `repo:`. The repository never holds `.env`, `space.env`, `data/` or database files; the template `.gitignore` already says so.

## 4. Adopt an existing project

Same end state as a created app, reached by adding to what exists:

- `space.yaml` at the repository root, name equal to the directory the app will live in;
- the service contract from step 3.2 (`PORT`, loopback, `/healthz`, `SIGTERM`); keep the project's old variables as fallbacks so it still runs standalone;
- storage read from `DATABASE_URL` / `DATABASE_URL_<NAME>` / `BLOB_URL` + `S3_*` first, old variables second. An existing SQLite file placed at `<workspace>/data/<app>/<database>.db` (`main.db` for the default database) before the first sync is kept as it is, never rewritten; see [docs/storage.md](../../docs/storage.md);
- a widget endpoint if the panel should show anything; `.env.example` covering every variable; `AGENTS.md` with the app-spec skeleton; the template `.gitignore` entries; the unit loading `space.env`;
- cron entries the project used to have become `tasks:` and leave the crontab.

Validate as in step 3.5.

## 5. Put it in the workspace

1. **Directory.** `<workspace>/apps/<name>` on the host is a clone or a checkout of the repository, never a copy without `.git`. Deployment channels, pick one and write it into the app's `AGENTS.md`: a bare repository with a `post-receive` hook (see ai-space `deploy/post-receive` for the pattern), `git pull` on the host, or the template `deploy.sh` (rsync, install the unit, restart, health check; no sudo).
2. **Secrets.** Real values go to `<workspace>/apps/<name>/.env` with `scp`; the workspace `.env` holds anything the manifest references as `${VAR}`.
3. **Service.** Until ai-space supervises services, a user-level systemd unit runs it: install `deploy/app.service` as `~/.config/systemd/user/<name>.service`, `loginctl enable-linger`, `systemctl --user enable --now <name>`. The unit loads the app `.env` and `<workspace>/data/<name>/space.env`, so provisioned storage reaches the process without code. Unit changes are not deployed by a git hook; reinstall the file and `daemon-reload` by hand (`deploy.sh` does).
4. **Register.** No restart is needed in either case.
   - A **new directory** is registered by the workspace-wide sync, which re-reads every `apps/*/space.yaml` the way boot does:

     ```bash
     curl -sS -X POST "$API/api/apps/sync" -H "authorization: Bearer $TOKEN"
     ```

     The response has `synced` (one summary per app: tasks created, updated, orphaned) and `skipped` (directory and parse error for every rejected manifest; the others still sync). Your app must be in `synced`.
   - An **existing app** re-reads only its own manifest:

     ```bash
     curl -sS -X POST "$API/api/apps/<name>/sync" -H "authorization: Bearer $TOKEN"
     ```

     A 400 carries the parse error and the previous good state stays.
5. **Expose** (only for apps with a page). Exposure is the operator's tunnel and access layer, outside ai-space: put the access rule in place before the hostname resolves, point the hostname at `127.0.0.1:<port>`, then write the public URL into `url:` and sync again. No `url`, no tile.

## 6. Edit an existing app

The manifest lives in the repository. Change it there, commit, deploy, sync; never edit `<workspace>/apps/<name>/space.yaml` in place for an app with code, because the next deploy silently reverts it. Manifest-only apps are the exception: they have no repository, so edit the file on the host (or delete and recreate through the API).

| Change | Do | Then |
| --- | --- | --- |
| identity (`title`, `description`, `icon`, `url`, `repo`) | edit the top level | sync; tile appears only with `url` |
| `service` | change command, port (check `GET /api/services` for clashes), health | reinstall the unit if the command or port changed; restart; sync |
| add or change an agent | `agents/<name>.md` + the `agents:` entry (`name`, `description`, `prompt`, `tools`, optional `avatar`, `model`, `skills`) | sync; `GET /api/agents` lists it; open one chat turn to prove the prompt and tool list |
| add or change a widget | endpoint in the service + the `widgets:` entry (`source`, `link`, `size`, `refresh` ≥ 15s) | sync; `GET /api/widgets` shows its payload or its error |
| add or change a task | one of `at` / `every` / `schedule`, one of `run.http` / `run.command` / `run.agent`, a `timeout`, optional `notify: { when: [error], channel }` | sync; `GET /api/tasks` shows the effective schedule; `POST /api/tasks/:id/run` with the token proves it |
| storage | `database`, `databases: [...]`, `blobs` | sync provisions and rewrites `space.env`; restart the service so it reads the new variables; nothing is ever dropped by a manifest change |
| notify | `channels`, `default`, `title`, `window` | every channel must exist as `SPACE_NOTIFY_<NAME>` in the workspace `.env`; sync |
| pause / archive | `status: paused` (listed, tasks and service stop) or `archived` (hidden, everything stops) | sync; storage stays |
| hide from the panel | `PATCH /api/apps/<name>` with `{ "hidden": true }`; the app stays registered and scheduled | not a manifest field; the layout keeps it |
| remove | delete `<workspace>/apps/<name>` and restart ai-space (the sync routes only add and update); tasks become orphaned, agents and widgets disappear | `<workspace>/data/<name>/` stays until the operator removes it by hand; confirm before deleting anything |

Parsing is strict: an unknown key, a wrong type or an unresolvable `${VAR}` rejects the whole app. Validate locally (step 3.5) before every deploy.

## 7. Verify

Every mode ends with evidence, not a claim:

```bash
curl -sS "$API/api/apps/<name>" | jq '.app | {name, status, url, agents: (.agents|length), widgets: (.widgets|length)}'
curl -sS "$API/api/services" | jq '.services[] | select(.app=="<name>")'       # port + health, apps with a service
curl -sS "$API/api/widgets"  | jq '.widgets[] | select(.app=="<name>")'         # widget payload or error
curl -sS "$API/api/tasks"    | jq '.tasks[] | select(.app=="<name>") | {name, nextRunAt: .state.nextRunAt}'
curl -sS "$API/api/agents"   | jq '.agents[] | select(.app=="<name>")'
curl -sS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:<port>/healthz"     # on the host
cat "$WS/data/<name>/space.env"                                                 # provisioned variables, never edited by hand
```

Then record what went live in the app's `AGENTS.md` (host, port, unit, deploy command, public URL) and report to the operator: repository, host and port, public URL or "no page", what the panel shows, and every step skipped with its reason.

## Pitfalls

- A new app directory is unknown to the per-app route: `POST /api/apps/<name>/sync` answers 404 until `POST /api/apps/sync` (or a boot) has seen the directory.
- An app without `url` has no tile even with a service, agents and widgets; an app with neither `url` nor `service` appears nowhere except `GET /api/apps?all=1`.
- A widget `source` given as a path needs a `service` with a port; an app without one must give a full URL.
- Manifests edited on the host drift from the repository and are lost on the next deploy. Edit in the repository.
- `space.env` is generated; hand edits are overwritten at the next sync. Change the manifest instead.
- A unit file is not part of what a git hook deploys. Copy it and `systemctl --user daemon-reload` yourself.
- Ports are unique per workspace; two services on one port fight silently. Check `GET /api/services` first.
- Task cron expressions live only in `space.yaml`; anything left in a crontab runs twice.
- Deleting an app directory does not delete `<workspace>/data/<name>/`; that is a separate, confirmed step.
- Bare `Bash` in an agent's `tools` is a shell for anyone who can reach the panel. Use `Bash(cmd *)` patterns.
