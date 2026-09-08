#!/usr/bin/env bash
# Install (or refresh) ai-space as a user-level systemd service on this machine.
# Run from the checkout: bash deploy/install.sh
# Idempotent: creates the workspace, installs the unit, enables linger, restarts.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || { echo "bun not found at $BUN (curl -fsSL https://bun.sh/install | bash)"; exit 1; }

cd "$HERE"
"$BUN" install --frozen-lockfile
SPACE_HOME="${SPACE_HOME:-$HOME/.ai-space}" "$BUN" src/index.ts init

mkdir -p ~/.config/systemd/user
sed "s|%h/.ai-space/core|$HERE|; s|%h/.bun/bin/bun|$BUN|" deploy/ai-space.service > ~/.config/systemd/user/ai-space.service
loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now ai-space
systemctl --user restart ai-space
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  if curl -fsS "http://127.0.0.1:${SPACE_PORT:-8700}/healthz"; then
    echo
    grep -qE '^SPACE_API_TOKEN=.+' "${SPACE_HOME:-$HOME/.ai-space}/.env" || echo "next: $BUN src/index.ts setup   (fills ${SPACE_HOME:-$HOME/.ai-space}/.env interactively; see docs/install.md)"
    exit 0
  fi
done
systemctl --user --no-pager --lines=10 status ai-space || true
echo "ai-space is not answering on 127.0.0.1:${SPACE_PORT:-8700}; see: journalctl --user -u ai-space -n 50" >&2
exit 1
