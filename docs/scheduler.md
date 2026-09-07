# Scheduler design

The scheduler is the Space-layer service for scheduled and event-driven tasks. Apps declare *when* something should run (a clock, an event another app publishes, or both) and *what* to run; ai-space keeps the clock, routes the events, executes the work, records every run, and exposes all of it through one API. Nothing is written to the system crontab. System cron or systemd only keeps the ai-space process alive.

## Goals and non-goals

Goals:

- One place to see every scheduled task across apps: schedule, last result, next run, history.
- Task definitions live next to the app code and are versioned with it.
- Apps written in any language can participate; the contract is an HTTP endpoint, a shell command, or a prompt file.
- Tasks can run on events as well as on the clock: an app publishes, tasks subscribe, ai-space coalesces. No broker.
- Survive restarts without losing schedules or silently skipping runs.
- Small enough to read in one sitting; no external queue or broker.

Non-goals:

- Sub-minute polling loops that need in-process state. Those stay inside the app.
- Distributed execution across machines. One scheduler serves the apps on its own machine.
- Workflow orchestration (step graphs, approvals). A task is one unit of work; "A finished, so run B" is an event, not a graph.

## Model

A task is a schedule and/or event triggers, a target, and bookkeeping state.

| Field | Meaning |
| --- | --- |
| `app`, `name` | Identity. Manifest tasks are keyed by the pair, so re-syncing is an upsert. |
| `schedule` | `at` (one ISO timestamp), `every` (fixed interval anchored to creation time), `cron` (5- or 6-field expression with optional IANA `tz`), or `manual` (no clock; only for a task with `triggers`). |
| `triggers` | Event triggers, see [Event triggers](#event-triggers): `event` (`<app>/<event>` or `<app>/*`), optional `filter` on the event's data, optional `debounce`. |
| `target` | `http` (request to an app endpoint), `command` (shell in the app directory), or `agent` (an agent runtime fed a prompt file). |
| `timeoutMs` | Hard limit per run. Past it the request is aborted or the process tree is killed. Default 10 minutes. |
| `enabled`, `overrides` | The manifest value and the operator's overrides (`enabled`, `schedule`). Overrides survive re-sync. |
| `source` | `manifest` or `api`. |
| `orphaned` | A manifest task that disappeared from its manifest. Kept for history, never runs. |
| `state` | `nextRunAt`, `runningAt`, `lastRunAt`, `lastStatus`, `lastError`, `lastDurationMs`, `consecutiveErrors`, and `pending` (queued event ids and when they are due). |

Effective values: a task runs when `overrides.enabled ?? enabled` is true and it is not orphaned, on `overrides.schedule ?? schedule`.

Every execution produces a run record: start, end, status (`ok`, `error`, `skipped`), error text, the first few kilobytes of output, what started it (`trigger`: `schedule`, `manual` or `event`) and the ids of the events it carried. The store keeps the latest 500 runs per task.

## Storage

One SQLite file, `<workspace>/data/space.db`, with a `tasks` table (indexed identity columns plus JSON blobs for schedule, target, triggers, overrides, state), a `runs` table and an `events` table (the last 2000 published events). Ticks write only the state blob. Schema migrations follow the additive rule: new nullable columns only, applied on open.

## Engine

The engine is a single timer plus an in-flight set.

1. **Arm.** After every change the timer is pointed at the earliest `nextRunAt` among enabled, non-running tasks. The delay is clamped to 60 seconds so the loop recovers quickly after a process suspend or a wall-clock jump.
2. **Tick.** Load tasks. Clear `runningAt` markers older than two hours that no in-flight run owns. Give every enabled task without a `nextRunAt` one. A task is due when its `nextRunAt` or its pending events' due time has passed; launch due tasks in that order until the concurrency limit is reached. Re-arm.
3. **Run.** Mark `runningAt`, take the pending events along and clear them, persist, execute the target with an `AbortSignal` that fires at `timeoutMs`. The tick does not wait for the run.
4. **Finish.** Write state and the run record, compute the next `nextRunAt`, re-tick so a waiting task can take the freed slot.

Rules the engine enforces:

- **No overlap.** A task with `runningAt` set is never launched again. A manual run of a running task is refused.
- **Timeouts are real.** HTTP requests are aborted. Commands and agents start in their own process group (where `setsid` exists) and the whole tree is killed; after that the engine stops waiting on their pipes so an orphaned grandchild cannot hold a slot.
- **Errors back off.** Consecutive failures push the next run to at least 30 s, 1 m, 5 m, 15 m, then 60 m after the failure, never earlier than the natural next slot. Success resets the counter.
- **Missed runs execute.** A tick that finds nothing due only fills in missing `nextRunAt` values. It never advances a past-due value, so a run that was missed while the process was down or busy executes instead of being skipped.
- **First run.** An `every` task runs as soon as it is created or re-enabled. `cron` and `at` wait for their natural moment; `manual` never has one.
- **Events coalesce.** A burst of matching events, or events arriving while the task runs, produce one more run, never one per event.
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

## Event triggers

A task can run because something happened rather than because it is time. An app publishes an event; every enabled task whose `triggers` match runs once with the event as its payload. The scheduler engine is unchanged: an event is one more reason a task becomes due.

### Declaring

```yaml
tasks:
  - name: curate
    schedule: "30 14 * * *"                  # optional: a daily sweep as the safety net
    timezone: Asia/Shanghai
    triggers:
      - event: feed/item.added               # <app>/<event>; <app>/* matches every event of that app
        filter: { channel: [news, markets] } # top-level data fields, string equality; a list means any of
        debounce: 15m                        # quiet period after the last matching event; default 0
    run:
      agent: { runtime: claude, prompt: prompts/curate.md }
```

`triggers` is a list, or a single event name. A task with `triggers` and no time form gets `schedule: { kind: manual }`: it runs on events and on `POST /api/tasks/:id/run`, never on a clock. A task needs at least one of the two. The key is `triggers` rather than `on` for the same reason notify uses `when`: YAML 1.1 reads a bare `on` as true.

### Publishing

```
POST /api/events
Authorization: Bearer <SPACE_APP_TOKEN>
{ "name": "item.added", "data": { "id": 42, "channel": "news" } }
```

The publishing app comes from the token, and the event is stored as `<app>/<name>`; an app cannot publish under another app's name. The operator token (`SPACE_API_TOKEN`) is also accepted and then requires `app` in the body, for the CLI and for tests. `data` is a JSON object of at most 64 KB. The response is `202` with the stored event and the tasks it reached (`matched`). A command task already has `SPACE_API_URL` and `SPACE_APP_TOKEN` in its environment, so the last line of a pipeline is one `curl`.

Events are per machine, like tasks: a task subscribes to the apps on its own ai-space. Peers do not forward events.

### Delivery

- **Match.** Name first (exact, or `<app>/*`), then every `filter` field against the event's top-level `data` by string equality. No expressions; an app that needs more publishes a more specific event.
- **Queue, do not run.** A match adds the event to the task's `state.pending` and sets its due time to now plus the trigger's `debounce` (the longest one, when several triggers match). Another matching event before that restarts the quiet period.
- **One run for a burst.** When the task is due and free, one run starts with every pending event, oldest first. Events that arrive while the task is running queue for exactly one more run, however many they are. This is what makes "a video was ingested" safe to publish per video.
- **Clock and events share the task.** A run started by the schedule or by hand while events are pending takes them along; they are delivered once, never twice. `runs[].trigger` says what started the run and `runs[].eventIds` which events it carried.
- **Disabled means dropped.** A disabled, paused or orphaned task is not queued, and disabling a task drops what it had pending. The event itself stays in the history.
- **Everything else is unchanged.** Concurrency slots, timeouts, error backoff (a failing task's next clock run backs off; its pending events wait for the task to be free), `notify` and run records apply the same way.

### What a run sees

| Target | Payload |
| --- | --- |
| `http` | `event` (the latest) and `events` (all, oldest first) merged into the JSON body; a string body is sent as is. The header `x-space-trigger: schedule \| manual \| event` is on every request. |
| `command` | `SPACE_TRIGGER`, and with events `SPACE_EVENT` (the latest) and `SPACE_EVENTS` (all) as JSON. |
| `agent` | The same variables, and the prompt ends with an `## Events` section listing them as JSON. |

Each event is `{ name, app, at, data }`.

### Restart and loss

Pending events live in the task state in `space.db`, so a restart delivers them. Events published while ai-space is down get a connection error; the publisher decides whether to retry, and a task that also keeps a time schedule sweeps up what was missed. The `events` table keeps the last 2000 events for `GET /api/events` and for run history; a run whose events were pruned still lists their ids.

### Not yet

- Events ai-space itself publishes (`space/task.finished`, `space/service.down`), with a loop guard.
- External webhooks (`POST /api/hooks/:app/:hook` with a per-hook secret) turned into events.
- Forwarding between peers.

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

  - name: index
    triggers: [{ event: feed/item.added, debounce: 5m }]
    run:
      http: { method: POST, url: "http://127.0.0.1:${MY_APP_PORT:-8080}/jobs/index" }
```

Rules:

- At most one of `at` / `every` / `schedule`, and/or `triggers`; a task needs at least one of the two. Exactly one of `run.http` / `run.command` / `run.agent`. Durations accept `30s`, `10m`, `6h`, `1d`.
- An optional `notify: { when: [error, ok, recover, skipped], channel }` (or `notify: true` for `when: [error]`) makes the notify service report the task's outcomes; see [notify.md](notify.md). Independently, `SPACE_NOTIFY_TASKS=<channel>` reports every task that fails three times in a row.
- Sync is idempotent. A new task is created, a changed one updated, a missing one marked orphaned. A schedule change resets `nextRunAt`.
- Operator overrides set through the API are kept across re-sync. Clear one by patching it to `null`.
- A manifest that fails to parse rejects the whole app. Nothing partially applies.
- Manifest tasks cannot be deleted through the API; remove them from the manifest and re-sync. Orphaned tasks can be deleted.

### API: dynamic tasks

Tasks created through `POST /api/tasks` have `source: api`. They follow the same engine rules and can be edited or deleted freely. This is the path for tasks an agent creates during a conversation, such as a one-shot reminder with an `at` schedule. The body takes `triggers` in the manifest shape, and may omit `schedule` when it has them.

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
GET    /api/tasks/:id/runs?limit  history, newest first, each with trigger and eventIds
POST   /api/events                publish { name, data? }; app token, or operator token plus app (202)
GET    /api/events?limit&name&app recent events, newest first
POST   /api/apps/sync             discover every app directory and re-read each space.yaml (registers new apps, forgets the ones whose directory is gone: `gone`)
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
| Fifty events in a minute for one task | One run (after the debounce) with all fifty; anything published during it makes one more run. |
| Event for a task that is disabled | Not queued; `matched` is empty. The event is still in `GET /api/events`. |
| Publisher calls while ai-space is restarting | Connection refused; nothing stored. The publisher retries or the task's clock catches up. |
