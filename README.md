# ai-space

A personal AI space: one web entry, many apps, each app run by one or more AI agents, all sharing a common set of services on a single dedicated server.

## Architecture

![ai-space architecture](docs/architecture.svg)

Top to bottom:

- **Application layer.** A unified web UI is the only entry point. It lists the installed apps, lets you chat with any agent, shows app widgets on the home panel, and carries notifications and settings. Each app owns one or more agents and may contribute one or more widgets.
- **Space layer (ai-space core).** Shared services that every app and agent can call through one Space API instead of building their own: cloud storage, scheduled tasks, notifications, data backup, config and secrets, logs and monitoring. The core also keeps the app registry, routes requests to the right agent, and handles auth.
- **Runtime layer.** Agents run as [Claude Code](https://claude.com/claude-code) or Codex sessions. Skills, MCP tools, memory, and LLM access come from the runtime; agents reach the Space API as tools.
- **Infrastructure layer.** Everything runs on one dedicated Linux server with Bun, SQLite and the filesystem, cron, and a public domain.

The diagram source is `docs/architecture.svg`.

## Development

Install dependencies:

```bash
bun install
```

Run and check:

```bash
cp .env.example .env   # then edit: port, SQLite path, app directories to sync
bun run start          # boot the Space API on 127.0.0.1:8700
bun run dev            # hot reload
bun run check          # typecheck + tests
```

See [AGENTS.md](AGENTS.md) for the agent and contributor guide, including the commit format, and [CLAUDE.md](CLAUDE.md) for Bun conventions.

## Services

- **Scheduler** (`src/space/scheduler/`) - scheduled tasks for apps: `at` / `every` / `cron` schedules, `http` / `command` / `agent` targets, declared in each app's `space.yaml` and managed through `/api/tasks`. See [docs/scheduler.md](docs/scheduler.md).

## Status

Early stage. The scheduler is the first Space service; the other layers above describe the target design and will be filled in module by module.
