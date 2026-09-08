# First install on a server

How to bring ai-space up on a fresh Linux machine, from an empty user account to a panel reachable on a domain behind an access layer, with agents, storage, notifications and app deploys working. Everything runs as one non-root user; sudo is needed only for the few system packages named below.

The order matters: each step only needs what the steps before it produced.

| Step | What it produces | Needed by |
| --- | --- | --- |
| 1. Server user and base tools | a user, git, Bun, a locale and time zone | everything |
| 2. Claude Code | the runtime login agents run with | panel chat, `agent` tasks, "Add from link" |
| 3. GitHub CLI | HTTPS git credentials and an identity | cloning apps, agents that push |
| 4. ai-space core | `~/.ai-space`, the unit on `127.0.0.1:8700`, git-push deploys, `bun run setup` | steps 5 to 9 |
| 5. Cloudflare Tunnel and DNS | the panel and app hostnames | opening the panel from anywhere |
| 6. Cloudflare Access | who may open those hostnames | must exist before the panel hostname does |
| 7. Cloudflare R2 | `SPACE_S3_*` | daily backups of every app, apps that declare `storage.blobs: s3` |
| 8. Notifications | `SPACE_NOTIFY_*` | task failure reports, apps that notify |
| 9. Peers | `SPACE_NAME`, `SPACE_HUB_TOKEN` or `SPACE_PEER_*` | only with a second machine |
| 10. First app and checks | a tile, a chat, a task run | done |

## Letting an agent install it

The steps below are written for a person, but a coding agent with a shell (Claude Code, Codex, or any similar tool) follows them just as well, and it is the way to go when you would rather answer questions than type commands. The agent's own procedure, with the questions to ask, the stops and a checklist, is [install-by-agent.md](install-by-agent.md); this file stays the reference it points into. Two shapes, depending on where the agent runs.

**The agent runs on your machine, the server is remote.** Open the agent in a checkout of this repository, make sure `ssh <host>` works from a terminal (a host alias in `~/.ssh/config` is enough), and ask:

> Install ai-space on `<host>` following docs/install-by-agent.md. Do the root part of step 1 with sudo and the rest as the user that will own ai-space; stop at every step that needs a login in a browser and tell me what to do.

It runs steps 1 to 4 over SSH and comes back with the browser logins of steps 2, 3 and 5 (a URL and a code each, which it can relay) and the Access application of step 6. Steps 7 to 10 need values from you (bucket credentials, a webhook URL); give them in the terminal when it asks, they end up in the workspace `.env` and nowhere else.

**The agent runs on the server.** Install and log in to the agent first, which for Claude Code is step 2, then clone the repository and start the agent inside the checkout:

```bash
git clone https://github.com/<owner>/ai-space.git ~/.ai-space/core
cd ~/.ai-space/core && claude        # or: codex
```

> Install ai-space on this machine following docs/install-by-agent.md; this directory is the checkout.

Starting it inside the checkout matters: the agent reads `AGENTS.md` and the docs directly and runs `deploy/install.sh` from where they are. For Claude Code the login it needs to run is the same one step 2 asks for, so that is done once.

In both shapes, `bun run setup` is interactive and made for a terminal; an agent fills `~/.ai-space/.env` from `.env.example` instead (`deploy/install.sh` creates the file), restarts the unit, and runs the checks of step 10. Ask it to show you the `.env` values it chose before it writes them.

There is no `curl | bash` installer on purpose: ai-space is only useful with a coding agent, so the agent is the installer.

Secrets end up in exactly two places: the workspace `.env` (`~/.ai-space/.env`, read by ai-space and by `${VAR}` in manifests) and the tools' own stores (`~/.claude`, `~/.config/gh`, `~/.cloudflared`). Nothing is committed.

## 1. Server user and base tools

Assumptions: Debian or Ubuntu, a public IP or at least outbound internet, SSH access with a key. Any distro with systemd user sessions works.

```bash
# as root, once
adduser space && usermod -aG sudo space          # or any user name; the rest runs as this user
apt-get update && apt-get install -y git curl unzip build-essential
timedatectl set-timezone Asia/Shanghai           # cron tasks without `tz` use the system zone
# optional: swap on a small box (1 to 2 GB RAM); each agent session costs ~150 MB
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

```bash
# as the space user
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519   # only if the machine must push anywhere
curl -fsSL https://bun.sh/install | bash            # Bun 1.3+ under ~/.bun
echo 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"' >> ~/.profile && source ~/.profile
bun --version
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global init.defaultBranch main
```

Do not open any port other than SSH. ai-space, every app service and the peer routes bind loopback; the tunnel in step 5 is the only way in. With `ufw`: `ufw default deny incoming && ufw allow OpenSSH && ufw enable`.

Per-app runtimes (Python, uv, Node, ffmpeg) are installed when the app needs them, not here. An interpreter path an app needs at task time goes into the workspace `.env` as a plain variable (`MY_APP_PYTHON=...`) and is referenced as `${MY_APP_PYTHON}` in its manifest.

## 2. Claude Code

The panel chat, `agent` scheduler targets and the "Add from link" flow all spawn `claude -p` as this user, so the CLI must be installed and logged in for this user, in this home.

```bash
curl -fsSL https://claude.ai/install.sh | bash      # native installer, no Node required
claude --version
claude                                              # first run: pick a theme, then /login
```

Login on a headless machine: `/login` prints a URL; open it on your laptop, sign in, paste the code back into the terminal. The token is stored under `~/.claude/` (no keychain on Linux) and refreshes itself. Two alternatives:

- An API key instead of a subscription login: put `ANTHROPIC_API_KEY=...` in `~/.ai-space/.env`; ai-space loads that file into its environment and the spawned `claude` inherits it.
- A different binary or wrapper: `SPACE_CHAT_BIN=/path/to/claude` in the same file.

Then check the exact call ai-space makes, from a directory that will exist (the workspace root, created in step 4, or `/tmp` for now):

```bash
claude -p "Say ok" --output-format json
```

Optional, in `~/.claude/settings.json`: a default model and any global permissions. ai-space passes `--model` from the request, the agent manifest, then `SPACE_CHAT_MODEL` (default `sonnet`), so a setting here only affects sessions started by hand. Skills under `~/.claude/skills/` are this user's and are visible to every agent session; the space's shared skills are the `skills/` directory of the checkout.

## 3. GitHub CLI

Apps live in `~/.ai-space/apps/<name>` and are usually clones of their repositories; agents that work on an app commit and may push. Use HTTPS with `gh` as the credential helper: one login, no deploy keys per repo.

```bash
# Debian/Ubuntu package repo, needs sudo once
(type -p wget >/dev/null || sudo apt-get install wget -y) \
 && sudo mkdir -p -m 755 /etc/apt/keyrings \
 && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
 && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
 && sudo apt-get update && sudo apt-get install gh -y

gh auth login --hostname github.com --git-protocol https --web   # device code, open on the laptop
gh auth setup-git                                                # git uses gh's token for https
gh auth status
```

Scopes: the default (`repo`, `read:org`, `gist`) is enough. Give the server its own account or a fine-grained token if agents will push, so that a compromised box can be revoked without touching your laptop. If a repo must be cloned over SSH instead, add the key from step 1 as a deploy key on that repo.

## 4. ai-space core

Two ways to put the code on the machine. Use the first for the first install; set up the second right after, because it is how every later version arrives.

**Clone once**

```bash
mkdir -p ~/.ai-space && git clone https://github.com/<you>/ai-space.git ~/.ai-space/core
cd ~/.ai-space/core && bash deploy/install.sh
```

`deploy/install.sh` runs `bun install --frozen-lockfile`, creates the workspace (`bun run init`: `apps/`, `data/`, `logs/`, a starter `.env`), installs `deploy/ai-space.service` into `~/.config/systemd/user/`, enables linger so the unit survives logout, starts it and curls `/healthz`.

**Git-push deploys, from the laptop**

```bash
ssh <host> "git init --bare ~/ai-space.git"
scp deploy/post-receive <host>:~/ai-space.git/hooks/post-receive && ssh <host> chmod +x ~/ai-space.git/hooks/post-receive
git remote add <host> <host>:~/ai-space.git
git push <host> main      # checks out into ~/.ai-space/core, runs deploy/install.sh, restarts the unit
```

**Workspace `.env`**

The interactive way: `bun run setup` in `~/.ai-space/core`. It checks the tools from steps 1 to 3 and step 5, asks for every value below and for the notification channel, R2 credentials and peers of steps 7 to 9 (each can be skipped and added on a later run), sends a test message, probes the bucket, shows a summary with secrets masked, writes `~/.ai-space/.env` keeping every line it did not touch, and restarts the unit. Existing values are the defaults, so re-running it is how a value is changed later.

By hand: edit `~/.ai-space/.env`; `.env.example` in the checkout lists every key. Set now:

```bash
SPACE_HOST=127.0.0.1
SPACE_PORT=8700
SPACE_API_TOKEN=$(openssl rand -hex 32)     # paste the value; mutating routes require it
SPACE_MAX_CONCURRENCY=4                     # slow agent tasks hold a slot for minutes; 2 is tight
SPACE_CHAT_MODEL=sonnet
SPACE_SERVICE_STOP="sudo systemctl disable --now {app}"   # what the panel runs when it uninstalls an app; user units: systemctl --user disable --now {app}
SPACE_NAME=<short machine name>             # what this space calls itself
```

Restart and check:

```bash
systemctl --user restart ai-space
journalctl --user -u ai-space -n 30 --no-pager
curl -s http://127.0.0.1:8700/healthz
curl -s http://127.0.0.1:8700/api/apps
```

If `systemctl --user` says the bus is not available, log out and back in once after `loginctl enable-linger`, or export `XDG_RUNTIME_DIR=/run/user/$(id -u)`.

## 5. Cloudflare Tunnel and DNS

ai-space binds loopback on purpose. The tunnel publishes chosen ports on hostnames of your domain, TLS included, with nothing listening on the public IP.

Prerequisites: the domain is on Cloudflare (nameservers switched, zone active) and you have a Zero Trust account (free tier is enough).

**Create the tunnel (dashboard-managed, recommended)**

In the Zero Trust dashboard: Networks → Tunnels → Create → Cloudflared, name it after the machine. It shows an install command with a token; take only the token and run cloudflared as a user unit, so this stays sudo-free and lives next to ai-space:

```bash
mkdir -p ~/.local/bin && curl -fsSL -o ~/.local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x ~/.local/bin/cloudflared
mkdir -p ~/.cloudflared && echo 'TUNNEL_TOKEN=<token>' > ~/.cloudflared/env && chmod 600 ~/.cloudflared/env

cat > ~/.config/systemd/user/cloudflared.service <<'EOF'
[Unit]
Description=cloudflared tunnel
After=network-online.target
Wants=network-online.target
[Service]
EnvironmentFile=%h/.cloudflared/env
ExecStart=%h/.local/bin/cloudflared --no-autoupdate tunnel run
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload && systemctl --user enable --now cloudflared
```

(`cloudflared service install <token>` does the same as a system service and needs sudo.)

**Public hostnames** (Tunnel → Public Hostname → Add), one per thing you publish:

| Hostname | Service | Notes |
| --- | --- | --- |
| `space.example.com` | `http://127.0.0.1:8700` | the panel; put Access on it before creating it (step 6) |
| `<app>.example.com` | `http://127.0.0.1:<app port>` | one per app with a page; this is the app's `url` in its manifest |

Each rule creates the proxied CNAME in DNS. Nothing else in DNS is needed. Keep the zone's SSL mode at Full (strict); the tunnel terminates TLS at Cloudflare and speaks plain HTTP to loopback.

The CLI route is equivalent when you prefer files over the dashboard: `cloudflared tunnel login`, `cloudflared tunnel create <name>`, an `ingress:` list in `~/.cloudflared/config.yml`, `cloudflared tunnel route dns <name> <hostname>` per hostname, and `cloudflared tunnel run <name>` in the unit instead of the token.

## 6. Cloudflare Access

The panel routes carry no token (see [panel.md](panel.md)): whoever reaches the panel can open a chat with write permissions, which is a shell as this user. The access layer in front of the tunnel is the authentication. Create it before the panel hostname goes live.

Zero Trust → Access → Applications → Add → Self-hosted:

- Application domain: `space.example.com`. Session duration: as you like (24 h is common).
- Identity: at minimum the One-time PIN login method; add an IdP (Google, GitHub) if you want one click instead of an emailed code.
- Policy `allow`: Emails = your address(es). Nothing else.
- Repeat for every `<app>.example.com` that is not meant to be public. A public app (a read-only page, a feed) gets no Access app.

Bypass rules the space needs later:

- **Peer routes** (step 9): the hub calls `/api/peer/*` on this hostname with a bearer token. Either add a policy `bypass` for the path `/api/peer/*` on that Access app, or create a service token (Access → Service Auth) and add a policy `Service Auth` that allows it; the hub then sends the token pair through `SPACE_PEER_<NAME>_HEADERS`.
- **App webhooks and API calls** from outside (a payment callback, a bot webhook): same choice, path bypass or service token, on that app's hostname.

Check from the laptop: the panel hostname shows the Cloudflare login page, then the panel; an incognito window is blocked; `curl -I https://space.example.com/api/apps` is a 302 to the login.

## 7. Cloudflare R2

Only needed when an app declares `storage.blobs: s3`; an app with `storage.blobs: file` uses `<workspace>/data/<app>/blobs/` and needs nothing here. R2 is recommended once files are large (video) or must survive the machine.

1. R2 → Create bucket. One bucket for the space is enough: each app gets its own prefix (`<app>/`) unless its manifest says otherwise.
2. R2 → Manage R2 API Tokens → Create API token: permission Object Read & Write, scoped to that bucket, no TTL. Note the Access Key ID, Secret Access Key and the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
3. In `~/.ai-space/.env`:

```bash
SPACE_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
SPACE_S3_REGION=auto
SPACE_S3_ACCESS_KEY_ID=...
SPACE_S3_SECRET_ACCESS_KEY=...
SPACE_S3_BUCKET=<bucket>
```

4. `systemctl --user restart ai-space`. The next sync of an app that declares `s3` runs one `list` call with these keys and refuses the sync if it fails, so a wrong key shows up in the log at once. The app then reads `BLOB_URL` and `S3_*` from its `space.env`.
5. Backups now have a target: `s3://<bucket>/backups/<SPACE_NAME>/` by default (`SPACE_BACKUP_URL` to change it; one prefix per machine). Run `bun src/index.ts backup space` once from `~/.ai-space/core` and check the object appeared; from then on every app is snapshotted daily around 03:00 (see [backup.md](backup.md)).

Optional: a custom domain on the bucket (R2 → Settings → Public access) when an app serves files straight from the bucket; the domain must be on the same Cloudflare zone.

## 8. Notifications

One channel called `default` is required as soon as any channel exists; apps that name no channel send there, and the scheduler reports tasks that failed three times in a row through `SPACE_NOTIFY_TASKS`. Pick the chat app you actually read.

**Telegram**

1. Talk to `@BotFather`, `/newbot`, keep the token.
2. Start a chat with the bot (or add it to a group and send one message), then read the chat id: `curl -s "https://api.telegram.org/bot<token>/getUpdates"` shows `chat.id` (negative for groups).
3. `SPACE_NOTIFY_DEFAULT=telegram://<token>@<chat_id>`.

**Feishu / Lark**: group settings → Bots → Custom bot; enable signature verification and copy the secret. `SPACE_NOTIFY_DEFAULT=feishu://open.feishu.cn/open-apis/bot/v2/hook/<token>?secret=<secret>`.

**Discord**: channel → Integrations → Webhooks; `SPACE_NOTIFY_DEFAULT=discord://<webhook_id>/<webhook_token>`. Slack, DingTalk, WeCom, Bark, ntfy and a generic webhook are listed in [notify.md](notify.md#channel-urls).

Then:

```bash
SPACE_NOTIFY_DEFAULT=...
SPACE_NOTIFY_TASKS=default
# optional second channel for a class of message: SPACE_NOTIFY_OPS=..., and apps name it in space.yaml
```

```bash
systemctl --user restart ai-space
curl -s -X POST -H "Authorization: Bearer $SPACE_API_TOKEN" http://127.0.0.1:8700/api/notify/channels/default/test
```

A message arrives, or `GET /api/notify/channels` shows the provider's error. Bot tokens live only here; apps never see them.

## 9. Peers

Skip this on a single machine. Peers are not addressed by IP: a peer is reached by its tunnel hostname (step 5), so the same hostnames serve both the operator and the hub. Decide which role this machine has:

- **This is the only machine, or the hub** (the one whose panel you open): nothing to set now. When a second machine exists, add to this `.env` `SPACE_PEER_<NAME>=https://space-<name>.example.com`, `SPACE_PEER_<NAME>_TOKEN=<that machine's SPACE_HUB_TOKEN>` and, if its Access app is not bypassed on `/api/peer/*`, `SPACE_PEER_<NAME>_HEADERS=CF-Access-Client-Id: ...; CF-Access-Client-Secret: ...`; restart; `GET /api/peers` shows `ok` and the counts.
- **This is a peer** of a hub elsewhere: `SPACE_HUB_TOKEN=$(openssl rand -hex 32)` and `SPACE_NAME=<name>` in this `.env`, the Access bypass or service token from step 6 on this panel hostname, and the token goes into the hub's `.env`.

What the hub token grants is everything the panel grants: chats with write permissions on this machine. Treat the hub's workspace accordingly. Details in [peers.md](peers.md).

## 10. First app and checks

Put an app in place and walk through every service once. The `space-app` skill (`skills/space-app/SKILL.md`) does this in a chat; by hand:

```bash
cd ~/.ai-space/apps && git clone https://github.com/<you>/<app>.git      # or write apps/<name>/space.yaml for a link app
# the app's own .env (its secrets), its runtime, its user unit if it has a service
curl -s -X POST -H "Authorization: Bearer $SPACE_API_TOKEN" http://127.0.0.1:8700/api/apps/sync
```

Then check, in this order:

1. `journalctl --user -u ai-space -n 50` shows the app synced: storage provisioned, tasks registered, no manifest error.
2. `https://space.example.com` shows the tile; the settings pop-over lists the service with its health.
3. Chat with "Base" (the space agent) and with the app's agent; the answer streams. With `acceptEdits` the agent can write in the app directory. Sessions reopen from the list.
4. Tasks drawer: run one task by hand (`POST /api/tasks/:id/run` with the token) and see the run and its output.
5. `cat ~/.ai-space/data/<app>/space.env` holds `DATABASE_URL`, `BLOB_URL` and `SPACE_APP_TOKEN`; the app's unit has `EnvironmentFile=-%h/.ai-space/data/<app>/space.env`.
6. Stop a task's target once so it fails three times, or post a test notification: the message arrives on the default channel.
7. `git push <host> main` from the laptop redeploys and the unit comes back within seconds.

## What is not covered yet

- **The workspace `.env`.** `~/.ai-space/data/` is snapshotted daily to the R2 bucket once step 7 is done (see [backup.md](backup.md); `bun src/index.ts backups` lists them, `backup-verify` opens the newest). `~/.ai-space/.env` is never in a snapshot: keep a copy in the password manager.
- **Service supervision.** Apps with a `service` run under their own user unit; ai-space probes health but does not start them. Install the unit from the app's `deploy/` directory and `daemon-reload` by hand.
- **PostgreSQL.** Only if an app declares `storage.database: postgres`: install the server, create a superuser for ai-space, set `SPACE_PG_ADMIN_URL`.
- **Codex.** The chat runtime is Claude Code only; a `codex` agent answers 501.

## Reinstall and recovery

The machine's identity is `~/.ai-space/.env`, `~/.ai-space/data/`, `~/.ai-space/apps/*/.env` and the three tool logins. With those restored on a fresh box, steps 1 to 4 and a `systemctl --user restart ai-space` bring everything back; the tunnel token and the Access apps are on Cloudflare's side and survive the machine.
