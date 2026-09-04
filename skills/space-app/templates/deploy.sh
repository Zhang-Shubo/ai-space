#!/usr/bin/env bash
# Deploy this app into an ai-space workspace on a remote host: rsync the
# checkout, install the user-level systemd unit, restart, check /healthz.
# No sudo anywhere. Bun must be installed under ~/.bun on the host.
#
#   DEPLOY_HOST=<ssh host> ./deploy.sh
#   DEPLOY_HOST=<ssh host> DEPLOY_PATH=.ai-space/apps/my-app SERVICE=my-app ./deploy.sh
#
# The host-side .env is never overwritten; on the first deploy it is seeded from
# the local .env. The unit is re-installed on every run, so editing
# deploy/app.service is enough.
set -euo pipefail

APP="${SERVICE:-my-app}"
DEPLOY_HOST="${DEPLOY_HOST:?set DEPLOY_HOST, e.g. DEPLOY_HOST=user@host ./deploy.sh}"
DEPLOY_PATH="${DEPLOY_PATH:-.ai-space/apps/$APP}"   # relative paths are under the remote home

echo "==> Syncing to ${DEPLOY_HOST}:${DEPLOY_PATH}"
ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_PATH'"
rsync -az --delete --exclude node_modules --exclude .env --exclude data --exclude .DS_Store ./ "$DEPLOY_HOST:$DEPLOY_PATH/"

echo "==> Ensuring host .env exists"
if ssh "$DEPLOY_HOST" "test -f '$DEPLOY_PATH/.env'"; then
  echo "    host .env present, keeping it"
else
  [ -f .env ] || { echo "ERROR: no local .env to seed the host with (copy .env.example)"; exit 1; }
  scp .env "$DEPLOY_HOST:$DEPLOY_PATH/.env"
fi

echo "==> Installing dependencies"
ssh "$DEPLOY_HOST" "cd '$DEPLOY_PATH' && ~/.bun/bin/bun install --production"

echo "==> Installing user systemd unit ${APP}.service"
remote_dir=$(ssh "$DEPLOY_HOST" "cd '$DEPLOY_PATH' && pwd")
sed -e "s|@DIR@|${remote_dir}|g" deploy/app.service |
  ssh "$DEPLOY_HOST" "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/${APP}.service"
ssh "$DEPLOY_HOST" "loginctl enable-linger \$(whoami) 2>/dev/null || true; systemctl --user daemon-reload && systemctl --user enable '${APP}'"

echo "==> Restarting ${APP}"
ssh "$DEPLOY_HOST" "systemctl --user restart '${APP}'"
sleep 3

echo "==> Health check"
port=$(ssh "$DEPLOY_HOST" "grep -E '^PORT=' '$DEPLOY_PATH/.env' | tail -1 | cut -d= -f2" || true)
port="${port:-8710}"
code=$(ssh "$DEPLOY_HOST" "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${port}/healthz'" || true)
if [ "$code" = "200" ]; then
  echo "    OK: /healthz returned 200 on port ${port}"
else
  echo "    FAILED: /healthz returned '${code}'"
  ssh "$DEPLOY_HOST" "journalctl --user -u '${APP}' -n 20 --no-pager"
  exit 1
fi

echo "==> Done. Register or re-read the manifest on the host:"
echo "    new app:      POST /api/apps/sync"
echo "    existing app: POST /api/apps/${APP}/sync"
