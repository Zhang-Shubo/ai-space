---
name: notify
description: Send a one-way notification to the operator's chat apps (Telegram, Discord, Slack, Feishu, DingTalk, WeCom, Bark, ntfy) through ai-space. Use when a prompt asks to notify, alert, ping, report or message someone about a result, or when a scheduled agent run should announce what it did. 当用户说"通知我""发个提醒""推送到群里""告警""发报告"时触发。
argument-hint: "[--level alert|warn|success|report|info] [--title ...] text"
allowed-tools: Bash(curl *)
user-invocable: true
---

# notify

ai-space delivers notifications for every app. You never touch bot tokens or channel markup: you post one JSON body to the Space API and ai-space renders it for each chat app, queues it, retries it and records the result.

## How to send

The environment of an app session carries `SPACE_API_URL` and the app's own `SPACE_APP_TOKEN` (from `space.env`). Send with `curl`:

```bash
curl -sS -X POST "$SPACE_API_URL/api/notify" \
  -H "authorization: Bearer $SPACE_APP_TOKEN" \
  -H "content-type: application/json" \
  -d '{"level":"warn","title":"Import finished with gaps","text":"12 of 40 files imported.\n28 were skipped: unknown format.","url":"https://example.test/report/42"}'
```

The call returns `202` with the notification id as soon as it is queued. Add `"wait": true` to get `200` with the per-channel delivery result instead; use it for the last message before the session ends.

Without `SPACE_APP_TOKEN` (an operator session), pass the operator token from `SPACE_API_TOKEN` and name the app: add `"app": "<app-name>"` to the body.

## Fields

| Field | Use |
| --- | --- |
| `level` | `info` (default), `success`, `warn`, `alert`, `report`. Picks the leading emoji: 🚨 alert, ⚠️ warn, ✅ success, 📊 report. `alert` means act now; use it rarely. |
| `title` | One line. Rendered bold. If omitted, the first line of `text` is the headline. |
| `text` | Plain text, newlines kept. No markdown, no HTML: ai-space escapes for each channel. |
| `url` | One link, shown as the last line. |
| `image` | `{ "url": "https://…" }` or `{ "data": "<base64>", "type": "image/png" }` (5 MB max). Channels that cannot upload get the text and a note. |
| `channels` | Channel names from the app's `notify.channels`. Default: the app's default channel. |
| `key` + `window` | Dedup: a second notification with the same key inside the window (default `10m`) is recorded, not sent. Use a stable key for recurring alerts (`"key": "feed-stalled"`). |

## Rules

- One message per event. Do not send a message for each item in a loop; send one summary with counts. Past 30 notifications to a channel in 10 minutes, ai-space suppresses the rest and posts one notice.
- Write for a phone screen: headline first, then two or three lines that say what happened and what to do, then the link.
- Nothing configured is not an error. If the operator set up no channel, the call still succeeds and the delivery is recorded as skipped; do not retry or work around it.
- Do not put secrets, tokens or full file dumps in a notification. Link to them instead.

## Checking what went out

```bash
curl -sS "$SPACE_API_URL/api/notifications?app=$SPACE_APP&limit=5"
```

Each notification lists its deliveries with `status` (`sent`, `queued`, `error`, `skipped`, `deduped`) and the provider's error text when there is one.
