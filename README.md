# ai-space

English | [中文](README.zh-CN.md)

A home for your AI: one place that connects and organizes several AI agents, apps and their data into a single system on a dedicated server.

It is one entry for all of it. Instead of switching between AI tools, you use and manage your own AI system through one web interface made of three things:

- **Apps** hold structured information and the scenarios you work in, and give the AI lasting context.
- **Agents** take on complex, unstructured requests and carry out the work.
- **Widgets** keep the important state and results visible at a glance.

Underneath, ai-space puts apps, agents, widgets, skills and data into one system instead of a set of separate tools: they share context and data, call each other's abilities, hand over tasks and results, and keep working towards the goals you set. The core supplies what a running AI system needs: scheduled tasks that fire on a clock or on events, notifications when a task finishes or turns up something important, backups of the data and results, storage, and one panel over several machines.

## Architecture

![ai-space architecture](docs/architecture.svg)

Top to bottom:

- **Application layer.** A unified web UI is the only entry point. It lists the installed apps, lets you chat with any agent, shows app widgets on the home panel, and carries notifications and settings. Each app owns one or more agents and may contribute one or more widgets.
- **Space layer (ai-space core).** Shared services that every app and agent can call through one Space API instead of building their own: cloud storage, scheduled tasks, notifications, data backup, config and secrets, logs and monitoring. The core also keeps the app registry, routes requests to the right agent, and handles auth.
- **Runtime layer.** Agents run as [Claude Code](https://claude.com/claude-code) or Codex sessions. Skills, MCP tools, memory, and LLM access come from the runtime; agents reach the Space API as tools.
- **Infrastructure layer.** Everything runs on one dedicated Linux server with Bun, SQLite and the filesystem, cron, and a public domain.

The diagram source is `docs/architecture.svg`.

## Workspace

Everything ai-space owns on a machine lives in one directory, `~/.ai-space` by default (override with `SPACE_HOME`). It is created on first boot or by `bun run init`:

```
~/.ai-space/
├── core/    ai-space itself (this repository) when deployed with deploy/
├── apps/    one directory per app; any app with a space.yaml is scheduled automatically
├── data/    runtime state (SQLite) and per-app data directories
├── logs/
└── .env     ai-space configuration plus the secrets app manifests reference via ${VAR}
```

## Development

```bash
bun install
bun run init           # create ~/.ai-space (idempotent)
bun run start          # boot the Space API and the panel on 127.0.0.1:8700
bun run dev            # hot reload, including the web UI
bun run check          # typecheck + tests
```

Local configuration goes in `~/.ai-space/.env` (see `.env.example`); process environment variables win over it.

## What you need

Five things, in the order you will use them. The first two are required; the rest make the result usable from anywhere and safe to keep.

1. **A coding agent.** [Claude Code](https://claude.com/claude-code), Codex, or any similar tool with a shell. It installs ai-space, it is the runtime the agents behind the panel run as, and it is how you build and maintain your apps. Bring its login: a Claude subscription or an API key.
2. **A cloud server.** One Linux box (Debian or Ubuntu, systemd, SSH with a key) that stays on. 1 vCPU and 2 GB RAM run the core with swap; 2 vCPU and 4 GB are comfortable once several apps and agent sessions run at the same time (each session costs about 150 MB).
3. **A Cloudflare account**, free tier. Tunnel publishes the panel and apps on your domain with no open port on the server, and can carry SSH too; Access puts a login in front of them; R2 (10 GB free) holds backups and app files. Without it the panel stays on loopback, reachable through an SSH port forward, and backups need another S3 bucket.
4. **GitHub CLI** (`gh`), logged in on the server, so the agent clones, commits and pushes app repositories for you with one login and no deploy keys.
5. **A domain hosted on Cloudflare.** Nameservers at Cloudflare, one hostname per app (`space.example.com` for the panel). This is what 3 publishes to.

The install walks through each of them in this order: [docs/install.md](docs/install.md).

## Deployment

Hand the procedure to a coding agent (Claude Code, Codex): from a checkout on your machine, ask it to install ai-space on `<host>` following `docs/install-by-agent.md`; or on the server, clone into `~/.ai-space/core`, start the agent inside that directory, and ask it to install ai-space on this machine. It stops at the browser logins and tells you what to do. See [docs/install-by-agent.md](docs/install-by-agent.md) and [docs/install.md](docs/install.md).

By hand: user-level systemd, no sudo. On the target machine, with Bun installed under `~/.bun`:

```bash
ssh <host> "git init --bare ~/ai-space.git"
scp deploy/post-receive <host>:~/ai-space.git/hooks/post-receive && ssh <host> chmod +x ~/ai-space.git/hooks/post-receive
git remote add <host> <host>:~/ai-space.git
git push <host> main      # checks out into ~/.ai-space/core, runs deploy/install.sh, restarts the unit
```

`deploy/install.sh` installs `deploy/ai-space.service` into `~/.config/systemd/user/`, enables linger, and restarts the service. Logs: `journalctl --user -u ai-space -f`.

On a new machine, `bun run setup` (in `~/.ai-space/core`) walks through the rest interactively: it checks the tools ai-space spawns (claude, gh, cloudflared), asks for every workspace `.env` value section by section, sends a test notification, probes the bucket, and prints what is left to do on Cloudflare. The full procedure, from an empty user to a panel behind a domain and an access layer, is in [docs/install.md](docs/install.md).

See [docs/app-spec.md](docs/app-spec.md) for the app specification (what an app is, its layout, and the `space.yaml` contract), [skills/space-app](skills/space-app/SKILL.md) for the shared skill that walks an agent through creating, adopting or changing an app by that specification (with the app template under `skills/space-app/templates/`), [AGENTS.md](AGENTS.md) for the agent and contributor guide, including the commit format, and [CLAUDE.md](CLAUDE.md) for Bun conventions.

## Services

- **Scheduler** (`src/space/scheduler/`) - scheduled and event-driven tasks for apps: `at` / `every` / `cron` schedules, event `triggers` fed by `POST /api/events` (debounced, coalesced, delivered as the run's payload), `http` / `command` / `agent` targets, declared in each app's `space.yaml` and managed through `/api/tasks`. See [docs/scheduler.md](docs/scheduler.md).
- **Storage** (`src/space/storage/`) - per-app databases on SQLite or PostgreSQL and a per-app blob store on the filesystem or any S3-compatible bucket, declared in `space.yaml`, provisioned on sync and handed over through `<workspace>/data/<app>/space.env` (`DATABASE_URL`, `BLOB_URL`, `S3_*`). The managed blob API from the design is not implemented yet. See [docs/storage.md](docs/storage.md).
- **Backup** (`src/space/storage/backup/`) - every app's data directory snapshotted daily to an S3 bucket (SQLite via `VACUUM INTO`, state files, one `tar.zst` per app with a sidecar manifest), counted retention, a weekly verification task that opens the newest snapshot, and `restore` into a directory or in place. See [docs/backup.md](docs/backup.md).
- **Notify** (`src/space/notify/`) - one-way notifications to chat apps (Telegram, Discord, Slack, Feishu, DingTalk, WeCom, Bark, ntfy, generic webhook). Channels are configured once in the workspace `.env` as `SPACE_NOTIFY_<NAME>` URLs; apps declare which they may use in `space.yaml` and send one `POST /api/notify`. Deliveries are queued, rate limited, retried and recorded; the scheduler reports failing tasks through it. See [docs/notify.md](docs/notify.md).
- **Panel** (`src/space/panel/`, `src/space/agents/`, `src/web/`) - the web entry at `/`: a launcher of every app in the workspace (icon, entry URL, health), a chat window that opens a Claude Code session as any declared agent or as the space agent, widget cards fed by the apps, a read-only view of every scheduled task with its run history, and an edit mode to add an app from a link, hide, reorder or uninstall. In English or Chinese, following the browser or a setting; apps translate their own titles in `space.yaml` ([docs/i18n.md](docs/i18n.md)). See [docs/panel.md](docs/panel.md).

## Status

Early stage. Scheduler (schedules and event triggers), storage (databases and blob hand-over), backups, notifications, the panel (agent chat, widgets, add from link, uninstall), peers (one panel over several machines, [docs/peers.md](docs/peers.md)) and the interactive `setup` are in place. Follow-up work, roughly in order:

- **Service supervision** - start `service.command`, restart it on failure, collect its logs under `<workspace>/logs/<app>/`; until then services are systemd units the operator installs, and the panel probes health directly.
- **Skills mounting** - make `skills:` and `memory:` from the manifest available to agent sessions; both are parsed today.
- **Managed blob API** - index table, streaming routes and presigning on top of the blob stores that are already provisioned and handed over.
- **App tooling** - `schema/space.schema.json`, `validate`, `/api/spec` and `bun run new-app`; the shared skill `skills/space-app/` does this by hand today.

The per-area table is in [docs/app-spec.md](docs/app-spec.md#implementation-status).
