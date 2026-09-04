# My App - agent guide

Read this before touching code. Users read [README.md](README.md). This repository is an ai-space app; the contract is ai-space `docs/app-spec.md` (spec 1) and `space.yaml` is the only file ai-space reads.

## Rules

1. **Be honest.** Data you cannot obtain stays empty or is marked missing; `/api/widget` returns `{ ok: false, error }` on failure and the panel shows it as is.
2. **Traceable.** Every record answers "where from, when".
3. **Append, never rewrite.** History is added to, not edited.
4. **Configuration is environment.** Real values live in `.env` (ignored) or in the `space.env` ai-space generates; the repository holds only `.env.example`.
5. **Loopback only.** The service binds `127.0.0.1:${PORT}`; exposure is the space's job.

## Stack and runtime model

- Bun + TypeScript, `src/index.ts` is the whole service (`Bun.serve`, `bun:sqlite`).
- Runs as the user-level systemd unit `my-app` from `~/.ai-space/apps/my-app`, port 8710, health `GET /healthz`.
- Storage and notifications are declared in `space.yaml` and reach the process as environment variables.

## Directory map

```
space.yaml           * the manifest: identity, service, agents, widgets, tasks, storage, notify
src/index.ts         * the service: /healthz, /api/widget, /jobs/refresh, SIGTERM handling
agents/assistant.md    system prompt of the `assistant` agent
prompts/               prompt files for scheduled agent tasks
deploy/app.service     user-level systemd unit template (@DIR@ substituted by deploy.sh)
deploy.sh              rsync, install the unit, restart, health check (no sudo)
icon.svg               panel icon, 64x64 viewBox
.env.example           every variable the service reads
```

## Conventions

- Widget contract: `GET /api/widget` -> `{ ok: true, items: [{ text, url, time }] }`, at most twenty items, newest first.
- Task endpoints (`/jobs/*`) do one round of work and answer `{ status: "ok" | "error" | "skipped", error? }`.
- Commit messages follow Conventional Commits.

## Commands

```bash
bun install
PORT=8710 bun src/index.ts
bun test
DEPLOY_HOST=<host> ./deploy.sh
```

## Environment variables

See `.env.example`. Provided by ai-space: `PORT`, `SPACE_APP`, `SPACE_APP_DIR`, `SPACE_APP_DATA_DIR`, `SPACE_API_URL`, `SPACE_APP_TOKEN`, plus `DATABASE_URL` / `BLOB_URL` when declared.

## Deployment

Fill in once live: host, workspace path, unit name, port, deploy command, public URL, tunnel or access rule id.

## Known pitfalls

- Record every trap the moment it is hit; this section is the one that pays for itself.
