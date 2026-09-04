# Notify design

The notify service is the Space-layer answer to "tell a human something happened". Apps, scheduled tasks and agents hand ai-space a message; ai-space renders it for each configured chat app, delivers it with retries and rate limits, and keeps a record. Credentials for chat apps live in the workspace once, never in an app.

Status: design only. This document covers **outbound, one-way notifications**. Inbound messages (commands, replies, chat with an agent from a phone) are a later stage; the section [Two-way later](#two-way-later) lists what this design keeps open for it.

## Why a Space service

Before ai-space, every app carried its own copy of the same forty lines: read `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, escape HTML, split at 4000 characters, retry on 429 with `retry_after`, prefix `[app-name]`, throttle repeated alerts. The copies drifted: one used GET with a query string and no retries, one added a second bot for a second kind of message, one added a 1.5 s minimum gap between sends, one degraded a failed photo to a text message. A shared library was written to end the copying, but a library still has to be adopted per app, per language, and every app still holds the bot token.

Moving the function down into ai-space follows app-spec rule 5, *declare, do not integrate*: an app says in `space.yaml` which channels it may use, and sends through one loopback HTTP call. The lessons from the copies become engine rules that every app gets for free.

## Goals and non-goals

Goals:

- One place for chat-app credentials: the workspace `.env`. Apps never see a bot token or a webhook URL.
- One message model that renders correctly on every supported chat app. An app writes the message once.
- Delivery that survives the failure modes seen in practice: 429s, network blips, messages over the size limit, alert storms, an app that sends from a loop.
- Apps in any language can participate. The contract is one HTTP request, or a CLI call from a shell task, or a skill for an agent.
- Every notification is recorded with its delivery result per channel, so "did the alert go out" has an honest answer.
- The scheduler can use it to report task failures without any app doing anything.

Non-goals, for now:

- Two-way messaging: bot commands, replies, inline buttons that call back. See [Two-way later](#two-way-later).
- Rich formatting beyond title, body, link and one image. No tables, no embeds, no per-channel layouts.
- End-user notifications at scale (an app notifying its own users). Channels are the operator's own chats. Fan-out is a few chat ids, not a subscriber list.
- WhatsApp and personal WeChat. Neither has an official API for a bot to message a person proactively without a business account and approved templates; the unofficial routes risk the account. Enterprise WeChat (WeCom) group robots are supported instead.
- Email as an alert channel. It can be added as a channel kind later; it is not a first-class target because nobody reads it in time.

## Model

Three things: a **channel** is where messages go, a **notification** is what an app sent, a **delivery** is one attempt to put one notification on one channel.

### Channel

A channel is a kind plus credentials plus a recipient, named by the operator and configured once for the workspace.

| Field | Meaning |
| --- | --- |
| `name` | Operator-chosen, `[a-z0-9][a-z0-9-]*`. `default` must exist when any channel exists. |
| `kind` | `telegram`, `discord`, `slack`, `feishu`, `dingtalk`, `wecom`, `bark`, `ntfy`, `webhook`, `stdout`. |
| `url` | Kind-specific URL holding credentials and recipient (see [Channel URLs](#channel-urls)). |
| `enabled` | Kill switch. Disabled channels accept notifications and record them as `skipped`. |
| `limits` | Derived from the kind: max text length, minimum gap between sends, burst allowance. Overridable per channel. |

Channels are the operator's, not the app's. An app that wants a second destination for a second class of message (orders on one bot, alerts on another) does not get a second token; the operator defines a second channel and the app names it.

### Notification

What an app hands over. Everything is plain JSON.

| Field | Type | Meaning |
| --- | --- | --- |
| `app` | string | Owning app. Set by ai-space from the caller's identity, never trusted from the body. |
| `level` | enum | `info` (default), `success`, `warn`, `alert`, `report`. Drives the leading emoji and, per channel, priority. |
| `title` | string? | One line. Rendered bold where the channel can. |
| `text` | string | Plain text body. Newlines are kept. No markup is interpreted; the service escapes for each channel. |
| `url` | string? | One link, rendered as the last line or as the title link where the channel supports it. |
| `image` | object? | `{ url }` or `{ data: base64, type: "image/png" }`, at most 5 MB. Sent as a photo with the text as caption; falls back to text when the channel cannot or the upload fails. |
| `channels` | string[]? | Channel names. Default: the app's manifest default, otherwise `["default"]`. |
| `key` | string? | Dedup key. A second notification with the same `app` and `key` inside `window` is recorded as `deduped` and not sent. |
| `window` | duration? | Dedup window for `key`. Default `10m`. |
| `wait` | boolean? | `true` makes the API call return only after delivery is attempted. Default `false` (202 immediately). |

A notification with no configured channel at all is recorded as `skipped` with reason `no channels` and the call still succeeds. Unconfigured is not an error; a fresh machine must not fail its apps.

Levels map to the leading emoji the existing apps already use by convention, so a chat that mixes old and new senders stays consistent:

| level | emoji | meaning |
| --- | --- | --- |
| `alert` | 🚨 | act now |
| `warn` | ⚠️ | worth knowing, no action |
| `success` | ✅ | something finished |
| `report` | 📊 | periodic digest |
| `info` | none | everything else |

The rendered first line is `<emoji> [<app title>] <title or first line of text>`. The `[app]` tag exists because several apps post into the same chat.

### Delivery

One row per notification per channel: `channel`, `status` (`queued`, `sent`, `error`, `skipped`, `deduped`), `attempts`, `lastError`, `sentAt`, and `providerId` (the chat app's own message id when it returns one). `providerId` is what a later two-way stage needs to edit or reply to a message.

## Channel URLs

Channels are configured in `<workspace>/.env` as `SPACE_NOTIFY_<NAME>=<url>`, one line per channel. This keeps one configuration file, matches how storage hands over `DATABASE_URL` and `BLOB_URL`, and keeps credentials out of every manifest.

```
# Chat channels. NAME becomes the channel name in lowercase. "default" is required
# when any channel is set; apps that name no channel send there.
SPACE_NOTIFY_DEFAULT=telegram://123456:AAxx@-1001234567890
SPACE_NOTIFY_TRADES=telegram://987654:BBxx@-1009876543210?thread=42
SPACE_NOTIFY_TEAM=discord://1234567890/abcdefghijkl
SPACE_NOTIFY_OPS=feishu://open.feishu.cn/open-apis/bot/v2/hook/xxxx?secret=yyyy
# Disable a channel without deleting it.
# SPACE_NOTIFY_TEAM_ENABLED=false
```

URL grammar per kind. Credentials sit in the URL; nothing else is needed.

| kind | URL | notes |
| --- | --- | --- |
| `telegram` | `telegram://<bot_token>@<chat_id>[,<chat_id>…][?thread=<topic_id>]` | Bot API `sendMessage` / `sendPhoto`, `parse_mode=HTML`, previews off. Several chat ids fan out. |
| `discord` | `discord://<webhook_id>/<webhook_token>` | Webhook `content`, plain text with a link line. Photo as multipart file. |
| `slack` | `slack://hooks.slack.com/services/<a>/<b>/<c>` | Incoming webhook, `text` in mrkdwn with escaping. Image as a link (webhooks cannot upload). |
| `feishu` | `feishu://open.feishu.cn/open-apis/bot/v2/hook/<token>[?secret=…]` | Custom bot, `text` message, signed when `secret` is set. Photo as a link (image upload needs an app, not a bot hook). |
| `dingtalk` | `dingtalk://oapi.dingtalk.com/robot/send?access_token=…[&secret=…]` | Custom robot, `markdown` message with a signed timestamp when `secret` is set. |
| `wecom` | `wecom://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…` | Group robot, `text` message; photo through the `image` message (base64 + md5, 2 MB limit). |
| `bark` | `bark://<host>/<device_key>` | iOS push. `title` + `body`, `url` opens on tap, `level` maps to Bark's `level`. |
| `ntfy` | `ntfy://<host>/<topic>[?token=…]` | `title`, `message`, `click`, `priority` from level, `attach` from image url. |
| `webhook` | `webhook://<host>/<path>[?token=…]` | Generic `POST` of the notification JSON, bearer token from `token`. For anything not listed. |
| `stdout` | `stdout://` | Prints to the ai-space log. Development and tests. |

The parsing is strict, like manifests: a malformed URL rejects that one channel with a log line at boot and marks it `error` in `GET /api/notify/channels`. Other channels are unaffected.

Why URLs instead of a YAML file: the operator already edits `.env` for every other secret, `${VAR}` placeholders in manifests already read from it, and the shape is well known from other notification tools. If the list outgrows `.env`, a `notify.yaml` in the workspace can be added with the same fields; the model does not change.

## Manifest: `space.yaml`

An app declares its use of notifications in a `notify` section. It is optional; an app without one may still send to `default`.

```yaml
notify:
  default: ops                   # channel used when a request names none; default: default
  channels: [ops, trades]        # channels this app may name; default: [default]
  title: My App                  # tag in the first line; default: the app title, then the name
  window: 10m                    # default dedup window for keyed messages; default: 10m
```

Rules:

- A request naming a channel outside `channels` is rejected with 400. This is the only permission model: the operator decides in the manifest which of their chats an app can reach.
- A channel named in the manifest but not configured in `.env` is a warning at sync, not an error. The app works; sends to it are `skipped`.
- Tasks may ask for delivery reports (see [Scheduler integration](#scheduler-integration)).

## Sending

### From a service: HTTP

```
POST /api/notify
Authorization: Bearer <SPACE_APP_TOKEN>
Content-Type: application/json

{ "level": "alert", "title": "Feed stalled", "text": "No items for 3 hours.\nLast ok: 09:12 UTC", "url": "https://…", "key": "feed-stalled" }
```

Response `202 { "ok": true, "id": "n_…", "channels": ["ops"] }`, or `200` with the deliveries when `wait: true`. The app identity comes from the token: ai-space writes a per-app `SPACE_APP_TOKEN` into `space.env` alongside `DATABASE_URL`, and the notify route maps token to app. The shared `SPACE_API_TOKEN` is also accepted and then requires an explicit `app` in the body; that is the path for the CLI and for operators.

`SPACE_API_URL` is already in every app's environment, so the whole client is one `fetch`. No SDK.

### From a shell or a scheduled command

```
bun src/index.ts notify --app my-app --level warn --title "Backup" "Restore check failed"
```

The command posts to the running ai-space over loopback; when ai-space is not running it prints the message to stderr and exits 1, so a cron-style script notices. A `space-notify` wrapper on `PATH` is a deployment nicety, not part of the contract.

### From an agent

A shared skill `space:notify` documents the HTTP call and the level conventions so an agent session (declared in `agents:` or run as a task) can send a message with `curl` when a prompt asks for it. The skill is the same text as this section, shortened.

### From ai-space itself

Space services call the same function in-process. The first internal consumer is the scheduler.

## Rendering

The service owns rendering. An app never writes channel markup and never escapes anything; the double-escaping bug that bit the earlier copies cannot happen because there is no escape function on the app side.

Per channel, from the same notification:

| kind | title | text | url | image | limit |
| --- | --- | --- | --- | --- | --- |
| telegram | `<b>` | HTML-escaped | last line as `<a>` | `sendPhoto` with caption (≤ 1024), else text | 4096, split at 4000 by line |
| discord | `**bold**` | markdown special chars escaped | last line | multipart file | 2000, split at 1900 by line |
| slack | `*bold*` | `& < >` escaped | `<url|text>` | link only | 40000 |
| feishu | first line | as is | last line | link only | 30 KB |
| dingtalk | markdown title | markdown-escaped | last line | `![](url)` | 20000 |
| wecom | first line | as is | last line | separate image message | 2048 bytes, split by line |
| bark | `title` | `body` | `url` | `icon` when url given | 4 KB |
| ntfy | `title` | `message` | `click` | `attach` | 4 KB |
| webhook | JSON | JSON | JSON | JSON (url only, data stripped) | none |

Splitting: a message longer than the channel limit is split at line boundaries into numbered parts; only the first part carries the image. Nothing is truncated silently.

Emoji and the `[app]` tag are prepended after rendering the title, and only once per message, so a title that already starts with an emoji is not doubled.

## Delivery

The engine is an outbox with per-channel workers.

1. **Accept.** Validate, resolve channels, check dedup, write the notification and one `queued` delivery per channel. Return.
2. **Send.** Each channel has one worker that drains its queue in order. Between two sends it waits the channel's minimum gap (Telegram 1 s per chat, Discord 0.5 s, webhooks 0.2 s). This is the global rate limit the earlier copies lacked and one app's loop cannot starve another app.
3. **Retry.** Network errors and 5xx retry three times with 1 s, 3 s, 10 s waits. A 429 waits for the provider's `retry_after` (Telegram `parameters.retry_after`, Discord `retry_after`, `Retry-After` header otherwise), at most 60 s, and does not count as an attempt. Other 4xx are final: the message is wrong, retrying cannot help.
4. **Degrade.** A failed photo upload retries as text with the same content, once. Text never gets lost because an image was too large.
5. **Record.** Every attempt updates the delivery row. The last error text is kept as is, including the provider's body, which is what one needs to fix a broken webhook.

Rules the engine enforces:

- **Never block the app.** The default call returns before any network activity. `wait: true` exists for the last message before a process exits.
- **Storms are throttled twice.** `key` dedups identical alerts inside the window. On top of that, each app is limited to 30 notifications per channel per 10 minutes; past the limit the engine sends one `⚠️ [app] 27 more notifications suppressed for 10 minutes` and records the rest as `skipped`. A chat that receives 300 messages is a chat nobody reads.
- **Restart.** Queued deliveries survive in SQLite and are drained on start, oldest first. Deliveries older than one hour that were never sent are marked `skipped` with reason `stale` instead of arriving late and confusing whoever reads them.
- **Disabled means skipped, not lost.** A channel with `_ENABLED=false` records `skipped`; flipping it on does not replay history.

## Storage

Two tables in `<workspace>/data/space.db`, following the additive migration rule: `notifications` (id, app, level, title, text, url, key, has image, created) and `deliveries` (notification id, channel, status, attempts, last error, provider id, sent at). Images are not stored in the database; `data` payloads are written to `<workspace>/data/<app>/notify/` and deleted after delivery. The store keeps the latest 2000 notifications per app.

## API

Listens with the other Space routes on `SPACE_HOST:SPACE_PORT`. Mutating routes require `SPACE_APP_TOKEN` or `SPACE_API_TOKEN` as a bearer token.

```
POST   /api/notify                       send; body as in Sending; 202 or 200 with wait
GET    /api/notify/channels              every channel: name, kind, enabled, last sent, last error; no credentials
POST   /api/notify/channels/:name/test   send a test message to one channel; operator token only
GET    /api/notifications?app&limit      history, newest first, with deliveries
GET    /api/notifications/:id            one notification and its deliveries
```

A panel widget for "last 20 notifications" falls out of the history route; it is not part of this change.

## Scheduler integration

The scheduler is the first sender and needs no app cooperation. Two hooks:

- **Workspace level.** `SPACE_NOTIFY_TASKS=default` makes the scheduler send `🚨 [app] task <name> failed 3 times: <error>` after three consecutive errors, and `✅ [app] task <name> recovered` on the next success. Three matches the backoff table; one failure is noise. Empty disables it.
- **Task level.** A task may override:

```yaml
tasks:
  - name: daily-digest
    schedule: "30 14 * * *"
    notify: { on: [error, ok], channel: reports }   # on: error (default) | ok | recover | skipped
    run:
      agent: { prompt: prompts/daily-digest.md }
```

`on: ok` for a task that runs once a day gives the daily "the digest went out" message without the task's own code sending anything. Task notifications use `key: task:<id>:<status>` with the task's own interval as the window, so a failing five-minute task produces one alert, not sixty.

## Two-way later

Nothing here is inbound, but three choices keep the door open:

- Channel URLs already hold the bot token, which is what an inbound Telegram or Discord bot needs. Adding inbound means one long-poll or webhook per channel, not a new credential model.
- `providerId` on every delivery lets a later stage edit a sent message or thread a reply under it.
- The `agents` section of the app spec is the natural target for an inbound message: a channel gets a `route: my-app/assistant` and messages become chat turns. That stage is where the panel's chat route and this service meet.

What two-way will need that this design does not provide: per-sender identity and allow-lists, message state (which user, which thread), and a way for an app to receive events. Those are separate design work.

## Failure modes considered

| Situation | Behaviour |
| --- | --- |
| No channel configured | Recorded as `skipped`; the API succeeds; the app never errors because of notifications. |
| Bot token revoked | 401 from the provider is final; delivery `error` with the body; `GET /api/notify/channels` shows the last error; nothing retries forever. |
| Provider rate limits | Wait `retry_after`, resend; the app already returned. |
| App sends from a tight loop | Per-app cap, one suppression message, rest `skipped`. |
| Same alert every minute for an hour | `key` dedup; one message per window. |
| Message over the limit | Split by line, numbered parts. |
| Image too large or upload fails | Sent as text with a note that the image was dropped. |
| ai-space restarts with queued messages | Drained on start; anything older than one hour is marked `stale`. |
| App names a channel it is not allowed | 400 with the channel name; nothing sent. |
| Malformed channel URL in `.env` | That channel is `error` at boot with a log line; others work. |

## Implementation plan

Each step is one change with tests, in `src/space/notify/`.

1. `types.ts`, `channels.ts`: model, URL parsing for every kind, `.env` loading. Tests on parsing and on the `[app]` and emoji rules.
2. `render.ts`: per-kind rendering and splitting, with fixtures. Telegram and Discord first, since they are what is in use today; the webhook family (Slack, Feishu, DingTalk, WeCom, Bark, ntfy, generic) is one HTTPS POST each and follows.
3. `store.ts`, `engine.ts`: outbox, workers, retries, dedup, per-app cap, stale handling. Tests with a stub transport, including the 429 path.
4. `api.ts`, CLI subcommand, `SPACE_APP_TOKEN` in `space.env`, manifest `notify` section in `manifest.ts`.
5. Scheduler hooks (`SPACE_NOTIFY_TASKS`, `tasks[].notify`).
6. `space:notify` shared skill, `.env.example` and `app-spec.md` updates, a section in the README.

Migrating an app: delete its notify module, replace each call with the `POST /api/notify` request (or the CLI in a script), move its token and chat id lines from the app `.env` to `SPACE_NOTIFY_*` in the workspace `.env`, and drop its `escapeHtml` calls. Apps that kept a per-class kill switch (`NOTIFY_TRADES=0`) keep it in their own code; the channel-level switch is the operator's, not the app's.

## Open questions

- **Per-app token.** `SPACE_APP_TOKEN` in `space.env` is proposed here because it identifies the caller without trusting the body. It is a small addition to the app spec that other services (widgets, chat) will want too. The alternative, the shared `SPACE_API_TOKEN` plus a self-declared `app`, is simpler and fine on a single-user machine.
- **Markdown subset.** Plain text only in this version. If apps need bold and code spans in the body, the next step is a small markdown subset (`**bold**`, `` `code` ``, links) that the renderer converts per channel, still with no app-side escaping.
- **Channel config in YAML.** `.env` URLs are enough for a handful of channels. A workspace `notify.yaml` becomes worth it when channels need per-channel overrides (custom limits, a display name) that do not fit a URL query string.
