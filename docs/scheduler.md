# Scheduler

The scheduler is the Space-layer service for scheduled tasks. It replaces per-machine crontabs for app batch jobs: tasks are declared next to the app code, run by ai-space, and their history is queryable in one place.

It runs inside the ai-space process. Nothing is written to the system crontab; system cron (or systemd) only keeps the ai-space process alive.

## Model

A task is *when* + *what* + state:

| Field | Meaning |
| --- | --- |
| `schedule` | `at` (one-shot ISO timestamp), `every` (interval, anchored to creation time), or `cron` (5/6-field expression, optional IANA `tz`) |
| `target` | `http` (request to an app endpoint), `command` (shell in the app dir with the app's `.env`), or `agent` (`claude -p` / `codex exec` fed a prompt file) |
| `timeoutMs` | hard limit per run; the target is aborted or killed past it (default 10 min) |
| `enabled` + `overrides` | manifest value plus operator overrides that survive re-sync |
| `state` | `nextRunAt`, `runningAt`, `lastRunAt`, `lastStatus`, `lastError`, `lastDurationMs`, `consecutiveErrors` |

Tasks are keyed by `app + name`. Run history lives in a `runs` table (last 500 per task).

## Engine rules

- One timer aimed at the earliest due task, clamped to 60 s so the loop recovers after a suspend or clock jump.
- A tick launches due tasks up to `SPACE_MAX_CONCURRENCY` without awaiting them; every finished run re-ticks.
- A task never overlaps itself. A run past its timeout is aborted and recorded as an error.
- Errors back off 30 s → 1 m → 5 m → 15 m → 60 m and reset on success.
- A tick with nothing due only fills in missing `nextRunAt` values; it never advances a past-due one, so a missed run executes instead of being skipped.
- Stale `runningAt` markers are cleared on start and after 2 h.
- `every` tasks run immediately the first time; `cron` and `at` wait for their natural moment.

## Registering tasks: `space.yaml`

Apps declare static tasks in a `space.yaml` at their repository root. ai-space reads every directory listed in `SPACE_APPS` on boot and on `POST /api/apps/<app>/sync`.

```yaml
name: finance-news-feed
tasks:
  - name: market
    every: 30m
    timeout: 10m
    run:
      http:
        method: POST
        url: "http://127.0.0.1:${NEWS_FEED_PORT:-8799}/space/run"
        headers: { x-write-token: "${NEWS_FEED_WRITE_TOKEN:-}" }
        body: { task: market }

  - name: video-daily
    schedule: "30 14 * * *"
    timezone: Asia/Seoul
    timeout: 40m
    run:
      agent: { runtime: claude, prompt: scripts/video-curate-daily.md, model: sonnet }

  - name: db-backup
    schedule: "0 3 * * *"
    enabled: false
    run:
      command: bun scripts/backup.ts
```

Rules:

- Exactly one of `at` / `every` / `schedule` and exactly one of `run.http` / `run.command` / `run.agent` per task.
- `${VAR}` and `${VAR:-default}` in `http` url, headers and string bodies are resolved from ai-space's own environment. Secrets stay out of the manifest.
- `command` and `agent` run with the app directory as cwd and the app's `.env` merged into the environment.
- Sync is idempotent. A task removed from the manifest becomes `orphaned` (kept for history, never runs). A schedule change resets `nextRunAt`.
- Operator overrides (`enabled`, `schedule`) set through the API are kept across re-sync. Clear one by patching it to `null`.
- A manifest that fails to parse rejects the whole app; nothing partially applies.

## API

Listens on `SPACE_HOST:SPACE_PORT` (default `127.0.0.1:8700`). Mutating routes need `Authorization: Bearer $SPACE_API_TOKEN` when the token is set.

```
GET    /healthz
GET    /api/tasks
POST   /api/tasks                 { app, name, schedule, target, timeoutMs?, enabled? }
GET    /api/tasks/:id
PATCH  /api/tasks/:id             { enabled?, schedule? }   (null clears a manifest override)
DELETE /api/tasks/:id             API tasks and orphaned manifest tasks only
POST   /api/tasks/:id/run         force a run now (202, or 409 when already running)
GET    /api/tasks/:id/runs?limit  newest first
POST   /api/apps/:app/sync        re-read the app's space.yaml
```

## Relationship to schedule-kit and cron-board

In-process pollers that need sub-5-minute cadence or in-memory state stay in the app with `schedule-kit`. The Space scheduler owns self-contained batch jobs and anything that used to live in a crontab. The `space.yaml` `command` for such a job is usually the same command the poller's `disabledHint` already names.
