# Scheduler design

The scheduler is the Space-layer service for scheduled tasks. Apps declare *when* something should run and *what* to run; ai-space keeps the clock, executes the work, records every run, and exposes all of it through one API. Nothing is written to the system crontab. System cron or systemd only keeps the ai-space process alive.

## Goals and non-goals

Goals:

- One place to see every scheduled task across apps: schedule, last result, next run, history.
- Task definitions live next to the app code and are versioned with it.
- Apps written in any language can participate; the contract is an HTTP endpoint, a shell command, or a prompt file.
- Survive restarts without losing schedules or silently skipping runs.
- Small enough to read in one sitting; no external queue or broker.

Non-goals:

- Sub-minute polling loops that need in-process state. Those stay inside the app.
- Distributed execution across machines. One scheduler serves the apps on its own machine.
- Workflow orchestration (step graphs, approvals). A task is one unit of work.

## Model

A task is a schedule, a target, and bookkeeping state.

| Field | Meaning |
| --- | --- |
| `app`, `name` | Identity. Manifest tasks are keyed by the pair, so re-syncing is an upsert. |
| `schedule` | `at` (one ISO timestamp), `every` (fixed interval anchored to creation time), or `cron` (5- or 6-field expression with optional IANA `tz`). |
| `target` | `http` (request to an app endpoint), `command` (shell in the app directory), or `agent` (an agent runtime fed a prompt file). |
| `timeoutMs` | Hard limit per run. Past it the request is aborted or the process tree is killed. Default 10 minutes. |
| `enabled`, `overrides` | The manifest value and the operator's overrides (`enabled`, `schedule`). Overrides survive re-sync. |
| `source` | `manifest` or `api`. |
| `orphaned` | A manifest task that disappeared from its manifest. Kept for history, never runs. |
| `state` | `nextRunAt`, `runningAt`, `lastRunAt`, `lastStatus`, `lastError`, `lastDurationMs`, `consecutiveErrors`. |

Effective values: a task runs when `overrides.enabled ?? enabled` is true and it is not orphaned, on `overrides.schedule ?? schedule`.

Every execution produces a run record: start, end, status (`ok`, `error`, `skipped`), error text, and the first few kilobytes of output. The store keeps the latest 500 runs per task.

## Storage

One SQLite file, `<workspace>/data/space.db`, with a `tasks` table (indexed identity columns plus JSON blobs for schedule, target, overrides, state) and a `runs` table. Ticks write only the state blob. Schema migrations follow the additive rule: new nullable columns only, applied on open.

## Engine

The engine is a single timer plus an in-flight set.

1. **Arm.** After every change the timer is pointed at the earliest `nextRunAt` among enabled, non-running tasks. The delay is clamped to 60 seconds so the loop recovers quickly after a process suspend or a wall-clock jump.
2. **Tick.** Load tasks. Clear `runningAt` markers older than two hours that no in-flight run owns. Give every enabled task without a `nextRunAt` one. Launch due tasks in `nextRunAt` order until the concurrency limit is reached. Re-arm.
3. **Run.** Mark `runningAt`, persist, execute the target with an `AbortSignal` that fires at `timeoutMs`. The tick does not wait for the run.
4. **Finish.** Write state and the run record, compute the next `nextRunAt`, re-tick so a waiting task can take the freed slot.

Rules the engine enforces:

- **No overlap.** A task with `runningAt` set is never launched again. A manual run of a running task is refused.
- **Timeouts are real.** HTTP requests are aborted. Commands and agents start in their own process group (where `setsid` exists) and the whole tree is killed; after that the engine stops waiting on their pipes so an orphaned grandchild cannot hold a slot.
- **Errors back off.** Consecutive failures push the next run to at least 30 s, 1 m, 5 m, 15 m, then 60 m after the failure, never earlier than the natural next slot. Success resets the counter.
- **Missed runs execute.** A tick that finds nothing due only fills in missing `nextRunAt` values. It never advances a past-due value, so a run that was missed while the process was down or busy executes instead of being skipped.
- **First run.** An `every` task runs as soon as it is created or re-enabled. `cron` and `at` wait for their natural moment.
- **Restart.** On start, stale `runningAt` markers are cleared, past-due tasks are due immediately, and the manifest sync is idempotent.

Concurrency is a single limit for the whole scheduler (`SPACE_MAX_CONCURRENCY`). A slow task holds a slot for its whole duration, so size the limit to the number of long-running tasks that may overlap, not to CPU count.

## Targets

| Kind | What ai-space does | What the app provides |
| --- | --- | --- |
| `http` | Sends the request with interpolated url, headers and body. Any 2xx is `ok`. A 2xx JSON body of `{ "status": "ok" \| "error" \| "skipped", "error"?: string }` overrides that verdict. | An endpoint on `127.0.0.1` that does one round of work and reports honestly. |
| `command` | Runs `sh -c <command>` with the app directory as cwd and the app's `.env` merged into the environment. Non-zero exit is an error. | A command that does one round of work and exits. |
| `agent` | Starts the configured agent runtime in the app directory and feeds the prompt file on stdin. | A prompt file, and a runtime installed on the machine. |

`${VAR}` and `${VAR:-default}` placeholders in http urls, headers, string bodies and command strings resolve from the scheduler's own environment (`<workspace>/.env`). This keeps secrets and machine-specific paths out of manifests. Inside a command, shell variables are written as `$VAR` so the shell, not the scheduler, expands them.

The verdict protocol matters for apps with an internal on/off switch: an app can answer `skipped` with a reason instead of failing, and the scheduler records it without counting it as an error.

## Registering tasks

### Manifest: `space.yaml`

Static tasks are declared in a `space.yaml` at the app repository root. ai-space reads every `<workspace>/apps/*/space.yaml` (plus any directory listed in `SPACE_APPS`) on boot and on `POST /api/apps/<app>/sync`.

```yaml
name: my-app
tasks:
  - name: refresh
    every: 30m
    timeout: 10m
    run:
      http:
        method: POST
        url: "http://127.0.0.1:${MY_APP_PORT:-8080}/jobs/refresh"
        headers: { authorization: "Bearer ${MY_APP_TOKEN}" }
        body: { job: refresh }

  - name: daily-digest
    schedule: "30 14 * * *"
    timezone: UTC
    timeout: 40m
    run:
      agent: { runtime: claude, prompt: prompts/daily-digest.md, model: sonnet }

  - name: backup
    schedule: "0 3 * * *"
    enabled: false
    run:
      command: "${MY_APP_PYTHON:-python3} scripts/backup.py"
```

Rules:

- Exactly one of `at` / `every` / `schedule` and exactly one of `run.http` / `run.command` / `run.agent` per task. Durations accept `30s`, `10m`, `6h`, `1d`.
- An optional `notify: { when: [error, ok, recover, skipped], channel }` (or `notify: true` for `when: [error]`) makes the notify service report the task's outcomes; see [notify.md](notify.md). Independently, `SPACE_NOTIFY_TASKS=<channel>` reports every task that fails three times in a row.
- Sync is idempotent. A new task is created, a changed one updated, a missing one marked orphaned. A schedule change resets `nextRunAt`.
- Operator overrides set through the API are kept across re-sync. Clear one by patching it to `null`.
- A manifest that fails to parse rejects the whole app. Nothing partially applies.
- Manifest tasks cannot be deleted through the API; remove them from the manifest and re-sync. Orphaned tasks can be deleted.

### API: dynamic tasks

Tasks created through `POST /api/tasks` have `source: api`. They follow the same engine rules and can be edited or deleted freely. This is the path for tasks an agent creates during a conversation, such as a one-shot reminder with an `at` schedule.

## API

Listens on `SPACE_HOST:SPACE_PORT` (default `127.0.0.1:8700`). Mutating routes require `Authorization: Bearer $SPACE_API_TOKEN` when the token is set.

```
GET    /healthz
GET    /api/tasks                 effective view of every task, with state
POST   /api/tasks                 { app, name, schedule, target, timeoutMs?, enabled? }
GET    /api/tasks/:id
PATCH  /api/tasks/:id             { enabled?, schedule? }   null clears a manifest override
DELETE /api/tasks/:id             API tasks and orphaned manifest tasks only
POST   /api/tasks/:id/run         force a run now (202, or 409 when already running)
GET    /api/tasks/:id/runs?limit  history, newest first
POST   /api/apps/sync             discover every app directory and re-read each space.yaml (registers new apps)
POST   /api/apps/:app/sync        re-read the app's space.yaml
```

## Workspace and deployment

Everything lives under the workspace (`~/.ai-space` by default, `SPACE_HOME` to override): `core/` for this code, `apps/` for app checkouts, `data/` for SQLite and per-app data, `logs/`, and `.env`. The workspace is created on first boot or by `bun run init`.

ai-space runs as a user-level systemd unit (`deploy/ai-space.service`, installed by `deploy/install.sh`). Apps that need a long-running process run under their own unit, and the scheduler reaches them over `127.0.0.1`. A bare-repo `post-receive` hook (`deploy/post-receive`) turns `git push <host> main` into checkout, install and restart.

## Migrating an app

1. Add a `space.yaml` next to the app code. For each crontab entry, the `command` is usually the same line the crontab ran; for each in-process poller, expose one trigger endpoint and use an `http` target with the poller's interval.
2. Give the app a switch that disables its internal timers when the scheduler is in charge, and have the trigger endpoint answer `skipped` for anything the app has switched off locally.
3. Check the app out under `<workspace>/apps/<name>`, restart ai-space or call the sync endpoint, and remove the crontab entries once the first runs show up in `/api/tasks`.

What stays in the app: polling loops faster than a few minutes, loops that depend on in-memory state, and long-lived connections. Those are not scheduled tasks.

## Failure modes considered

| Situation | Behaviour |
| --- | --- |
| Process restarts mid-run | Marker cleared on start; the task is due again and runs once. An app that is still busy with the previous round answers `skipped`. |
| Target hangs forever | Aborted or killed at `timeoutMs`; recorded as an error; backoff applies. |
| Target fails repeatedly | Backoff grows to one hour; the task keeps its natural schedule otherwise. |
| Clock jumps forward | Timer fires within 60 s; every past-due task runs once. |
| More due tasks than slots | Earlier `nextRunAt` goes first; the rest wait and run as slots free up. |
| Manifest edited with a typo | Whole app rejected with a message; existing tasks untouched. |
| App down | `http` targets fail fast with a connection error and back off. |
