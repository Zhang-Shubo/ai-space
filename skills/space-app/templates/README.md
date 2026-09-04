# My App

One sentence saying what the app does, for the person who will use it.

## Use

- Open the app at its public URL (set as `url:` in `space.yaml`), or on the host at `http://127.0.0.1:8710`.
- The panel shows the `latest` widget and lets you chat with the `assistant` agent.

## Run locally

```bash
bun install
cp .env.example .env      # fill in real values; never commit .env
PORT=8710 bun src/index.ts
curl -s http://127.0.0.1:8710/healthz
```

Inside an ai-space workspace the provisioned variables (`DATABASE_URL`, `BLOB_URL`, ...) come from `<workspace>/data/my-app/space.env`. For local development against the same values: `eval "$(bun <ai-space>/src/index.ts env my-app)"`.

## Deploy

`DEPLOY_HOST=<ssh host> ./deploy.sh` syncs the checkout into `~/.ai-space/apps/my-app`, installs the user-level systemd unit and checks `/healthz`. See [AGENTS.md](AGENTS.md) for the host details once it is live.

This is an [ai-space](https://github.com/Zhang-Shubo/ai-space) app; the contract is its `docs/app-spec.md`.
