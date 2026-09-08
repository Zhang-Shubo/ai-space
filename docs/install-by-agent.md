# Installing ai-space as an agent

This is the procedure for a coding agent (Claude Code, Codex, or any tool with a shell) that has been asked to install ai-space. [install.md](install.md) is the reference and explains every choice; this file is the order to do things in, what to ask the person, where to stop, and how to prove the result. Read both before running anything.

## Ground rules

- **Two shapes.** Either you run on the person's machine and reach the server over `ssh <host>`, or you run on the server itself inside the checkout at `~/.ai-space/core`. Say which shape you are in at the start; every command below is meant for the server.
- **Root only for step 1.** Create the user, packages, time zone, swap and firewall with `sudo`, then do everything else as the user that owns ai-space. Never run the service, Bun, Claude Code or `gh` as root.
- **Stop at the browser.** The Claude login, `gh auth login`, the Cloudflare tunnel and the Access application need a browser. Print the URL or code, tell the person exactly what to do, wait.
- **Show before you write.** Print the `.env` values you intend to write, with secrets masked, and get a yes. Secrets go into `~/.ai-space/.env` or the tools' own stores and nowhere else; never into a commit, a log line or the chat transcript when it can be avoided.
- **No new ports.** ai-space, every app and the peer routes bind loopback; only SSH is open. Do not change that to "make it reachable".
- **Prove, do not assume.** Every phase ends with a command whose output you paste. The checklist at the end is the definition of done.

## Ask first

Before touching the machine, ask for what has no default:

1. The host and the SSH user you may use, or confirmation that you are on the server.
2. The name of the user that will own ai-space (default `space`; on a cloud image the existing sudo user is fine).
3. A short machine name for `SPACE_NAME`.
4. Whether the panel should be reachable from outside now (a domain on Cloudflare) or stay loopback-only for the moment.
5. Whether to configure now, or leave for a later run: a notification channel, an S3 or R2 bucket, a peer.

Everything else has a default from `.env.example` and the docs.

## Procedure

### Phase 1: system (root part of install.md step 1)

```bash
sudo adduser --disabled-password --gecos '' space && sudo usermod -aG sudo space   # skip if using an existing user
sudo apt-get update && sudo apt-get install -y git curl unzip build-essential
sudo timedatectl set-timezone <zone>
sudo loginctl enable-linger space
sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw --force enable
```

If you created a new user, copy the SSH key so the person can log in as it: `~/.ssh/authorized_keys` into the new home, owned by the user, mode 700 on the directory. Swap (2 GB) only on a box with 2 GB RAM or less.

Proof: `id space`, `timedatectl | grep zone`, `sudo ufw status`.

### Phase 2: Bun and git identity (user part of step 1)

As the ai-space user:

```bash
curl -fsSL https://bun.sh/install | bash
echo 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"' >> ~/.profile && source ~/.profile
git config --global user.name "<name>" && git config --global user.email "<email>" && git config --global init.defaultBranch main
```

Proof: `bun --version` prints 1.3 or newer.

### Phase 3: Claude Code (step 2)

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```

If the installer answers 403 (some cloud provider IP ranges are blocked), install from npm instead: `bun add -g @anthropic-ai/claude-code --registry https://registry.npmjs.org`. The explicit registry matters on images that ship a `~/.npmrc` pointing at a vendor mirror that does not carry the package.

Then stop: the person runs `claude` once and `/login` (URL plus code on a headless machine), or gives you an `ANTHROPIC_API_KEY` for the workspace `.env`. When they say it is done:

Proof: `claude -p "Say ok" --output-format json` from `/tmp` returns `"is_error":false`.

### Phase 4: GitHub CLI (step 3, optional)

Only needed to clone private app repositories or for agents that push. Install `gh` from the package repository as in install.md, then stop for `gh auth login --web` (device code). After: `gh auth setup-git`.

Proof: `gh auth status`.

### Phase 5: ai-space core (step 4)

```bash
mkdir -p ~/.ai-space && git clone https://github.com/<owner>/ai-space.git ~/.ai-space/core
cd ~/.ai-space/core && bash deploy/install.sh
```

`install.sh` installs dependencies, creates the workspace with a starter `.env`, installs and starts the user unit, and waits for `/healthz`. If `systemctl --user` reports no bus, `export XDG_RUNTIME_DIR=/run/user/$(id -u)` or log in again over SSH.

`bun run setup` is interactive and made for a terminal; do not drive it. Fill `~/.ai-space/.env` yourself from `.env.example`:

```bash
SPACE_HOST=127.0.0.1
SPACE_PORT=8700
SPACE_API_TOKEN=<openssl rand -hex 32>
SPACE_MAX_CONCURRENCY=2            # 4 on a box with 4 GB or more
SPACE_CHAT_MODEL=sonnet
SPACE_SERVICE_STOP=systemctl --user disable --now {app}
SPACE_NAME=<machine name>
```

Show the values, write them, `systemctl --user restart ai-space`.

Proof: `curl -s 127.0.0.1:8700/healthz` is `{"ok":true}`; `curl -s 127.0.0.1:8700/api/apps` lists zero apps; `journalctl --user -u ai-space -n 20` shows `listening on` and no error. Also set up git-push deploys from the person's machine if you are in the first shape (install.md step 4, second block) and prove it with one push.

### Phase 6: tunnel and Access (steps 5 and 6, only with a domain)

Order matters: the Access application first, the public hostname second, so the panel is never reachable without login.

1. Stop: the person creates the tunnel in the Zero Trust dashboard and gives you the token, and creates the Access application for `space.<domain>` with an allow policy on their email.
2. Install `cloudflared` under `~/.local/bin` and the user unit from install.md with the token in `~/.cloudflared/env` (mode 600).
3. Stop: the person adds the public hostname `space.<domain>` to `http://127.0.0.1:8700`.

Proof: `systemctl --user is-active cloudflared`; from outside, `curl -sI https://space.<domain>/api/apps` is a 302 to the Cloudflare login; the person opens the panel in a browser and sees it after login.

### Phase 7: bucket, notifications, peers (steps 7 to 9, each optional)

- **Bucket:** `SPACE_S3_*` in `.env`, restart, then `bun src/index.ts backup space` from the checkout. Proof: the object appears in the bucket; `bun src/index.ts backups` lists it.
- **Notifications:** `SPACE_NOTIFY_DEFAULT` and `SPACE_NOTIFY_TASKS=default`, restart. Proof: `POST /api/notify/channels/default/test` with the API token and the person confirms the message arrived.
- **Peer:** follow install.md step 9 for the role the person chose. Proof: `GET /api/peers` on the hub shows this machine `ok`.

### Phase 8: first app (step 10)

Clone or create one app under `~/.ai-space/apps/`, `POST /api/apps/sync`, then run the seven checks of install.md step 10. The `space-app` skill in `skills/space-app/` covers creating or adopting an app.

## Report back

End with: the shape you worked in, the user and workspace path, every `.env` key you set (values masked), the checklist below with each line marked, what was skipped and why, and the exact next action for the person if anything is waiting on them.

## Checklist

Base, required on every install:

- [ ] Non-root user owns ai-space; `sudo` works for it; only port 22 is open (`sudo ufw status`)
- [ ] Time zone set (`timedatectl`)
- [ ] `bun --version` is 1.3 or newer, on PATH in a fresh login shell
- [ ] git identity set (`git config --global -l`)
- [ ] `claude --version` works and `claude -p "Say ok" --output-format json` returns `"is_error":false`
- [ ] `~/.ai-space/core` is a clean checkout of the intended branch (`git status`, `git log -1`)
- [ ] `systemctl --user is-active ai-space` is `active`, `is-enabled` is `enabled`, `loginctl show-user <user> -p Linger` is `yes`
- [ ] `curl -s 127.0.0.1:8700/healthz` is `{"ok":true}`
- [ ] `ss -ltn` shows 8700 on 127.0.0.1 only
- [ ] `~/.ai-space/.env` has `SPACE_API_TOKEN`, `SPACE_NAME`, `SPACE_SERVICE_STOP`; mode 600; not in any git repository
- [ ] `journalctl --user -u ai-space -n 50` has no error lines
- [ ] The person has a copy of `.env` in their password manager (it is never in a backup)

Reachability, when a domain was requested:

- [ ] `cloudflared` user unit active; token file mode 600
- [ ] Access application exists for the panel hostname before the hostname does
- [ ] `curl -sI https://space.<domain>/api/apps` from outside is 302; an incognito browser is blocked; the person can log in and see the panel

Services, when requested:

- [ ] `gh auth status` logged in, `gh auth setup-git` done
- [ ] Bucket: `backup space` ran and `backups` lists the snapshot
- [ ] Notifications: test message received on the default channel
- [ ] Peer: `GET /api/peers` shows `ok` on the hub
- [ ] Git-push deploy: one push from the person's machine redeployed and `/healthz` came back

First app, when one was added:

- [ ] Tile visible, service health dot green (or no service)
- [ ] Chat with the space agent streams an answer
- [ ] One task run by hand shows its output in the tasks drawer
- [ ] `~/.ai-space/data/<app>/space.env` exists with the expected keys

## Known snags

| Symptom | Cause | Fix |
| --- | --- | --- |
| `claude.ai/install.sh` returns 403 | the cloud provider's IP range is blocked | `bun add -g @anthropic-ai/claude-code --registry https://registry.npmjs.org` |
| `bun add -g` returns 404 from a mirror | image ships `~/.npmrc` with a vendor registry | pass `--registry https://registry.npmjs.org`, or remove the line |
| Bun installer fails on unzip | `unzip` not installed | `apt-get install -y unzip` |
| `systemctl --user` says no bus | no user session (came in via `su`) | `export XDG_RUNTIME_DIR=/run/user/$(id -u)` or log in over SSH as the user |
| `/healthz` never answers after `install.sh` | the unit failed | `journalctl --user -u ai-space -n 50`; usually a bad `.env` line |
| Panel opens without a login page | hostname created before the Access application | remove the hostname, create Access, add it again |
