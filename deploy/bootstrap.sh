#!/usr/bin/env bash
# One-line install of ai-space on a Linux machine, as the current (non-root) user:
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/ai-space/main/deploy/bootstrap.sh | bash
#
# What it does, in order, each step skipped when already done:
#   1. checks git, curl and a user systemd session
#   2. installs Bun under ~/.bun and Claude Code under ~/.local/bin
#   3. clones (or fast-forwards) the repository into ~/.ai-space/core
#   4. runs deploy/install.sh: dependencies, workspace, user unit, start
#   5. runs the interactive `setup` walk-through on the terminal (/dev/tty),
#      so it works even though stdin is the pipe curl writes to
#
# Variables: AI_SPACE_REPO (clone URL), AI_SPACE_REF (branch, default main),
# AI_SPACE_GIT_TOKEN (a GitHub token when the repository is private; a logged-in
# `gh` is used otherwise), SPACE_HOME (workspace, default ~/.ai-space),
# AI_SPACE_NO_SETUP=1 to skip step 5.
# The whole file is one function called on the last line, so a download cut
# short runs nothing. The full procedure is docs/install.md.
set -euo pipefail

main() {
  local repo="${AI_SPACE_REPO:-https://github.com/Zhang-Shubo/ai-space.git}"
  local ref="${AI_SPACE_REF:-main}"
  local home="${SPACE_HOME:-$HOME/.ai-space}"
  local core="$home/core"
  local bun="$HOME/.bun/bin/bun"

  say "ai-space bootstrap"
  say "  repo      $repo ($ref)"
  say "  workspace $home"
  echo

  # 1. preflight
  [ "$(id -u)" -ne 0 ] || die "run as the user that will own ai-space, not root (adduser first; sudo is not needed)"
  [ "$(uname -s)" = "Linux" ] || die "Linux only: the service is a user-level systemd unit"
  need git "apt-get install -y git"
  need curl "apt-get install -y curl"
  if ! systemctl --user is-system-running >/dev/null 2>&1 && ! systemctl --user list-units >/dev/null 2>&1; then
    die "no user systemd session; log in over SSH as this user (not su), or: export XDG_RUNTIME_DIR=/run/user/\$(id -u)"
  fi

  # 2. runtimes
  if [ -x "$bun" ]; then
    say "bun $("$bun" --version) present"
  else
    say "installing Bun"
    curl -fsSL https://bun.sh/install | bash >/dev/null
    [ -x "$bun" ] || die "Bun did not install to $bun"
  fi
  export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
  if command -v claude >/dev/null 2>&1; then
    say "claude $(claude --version 2>/dev/null | head -1) present"
  else
    say "installing Claude Code"
    curl -fsSL https://claude.ai/install.sh | bash >/dev/null
    command -v claude >/dev/null 2>&1 || say "claude not on PATH yet; open a new shell or add ~/.local/bin to PATH"
  fi
  add_path_once

  # 3. code
  if [ -d "$core/.git" ]; then
    say "updating $core"
    git -C "$core" fetch -q origin "$ref"
    if [ -z "$(git -C "$core" status --porcelain)" ]; then
      git -C "$core" checkout -q "$ref"
      git -C "$core" merge -q --ff-only "origin/$ref" || die "$core has diverged from origin/$ref; resolve by hand"
    else
      say "  local changes present; not touching the checkout"
    fi
  else
    say "cloning into $core"
    mkdir -p "$home"
    git clone -q --branch "$ref" "$(clone_url "$repo")" "$core"
    git -C "$core" remote set-url origin "$repo"   # never keep a token in .git/config
  fi

  # 4. service
  say "installing the service"
  SPACE_HOME="$home" BUN="$bun" bash "$core/deploy/install.sh"
  echo

  # 5. walk-through
  if [ "${AI_SPACE_NO_SETUP:-}" = "1" ]; then
    say "setup skipped (AI_SPACE_NO_SETUP=1); later: cd $core && bun run setup"
  elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
    (cd "$core" && SPACE_HOME="$home" "$bun" src/index.ts setup </dev/tty >/dev/tty)
  else
    say "no terminal; later: cd $core && bun run setup"
  fi

  echo
  say "done. Logs: journalctl --user -u ai-space -f   Docs: $core/docs/install.md"
}

say() { printf '[bootstrap] %s\n' "$*"; }

# The clone URL with credentials for a private GitHub repository: AI_SPACE_GIT_TOKEN,
# else the token of a logged-in gh. A public repository or a non-https URL is returned as is.
clone_url() {
  local url="$1" token="${AI_SPACE_GIT_TOKEN:-}"
  case "$url" in https://github.com/*) ;; *) echo "$url"; return ;; esac
  if [ -z "$token" ] && command -v gh >/dev/null 2>&1; then token="$(gh auth token 2>/dev/null || true)"; fi
  if [ -n "$token" ]; then echo "https://x-access-token:${token}@${url#https://}"; else echo "$url"; fi
}
die() { say "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required: $2"; }

# Make ~/.bun/bin and ~/.local/bin available in later logins, once.
add_path_once() {
  local line='export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"'
  local f
  for f in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$f" ] || continue
    grep -qF '.bun/bin' "$f" || printf '\n%s\n' "$line" >> "$f"
  done
  [ -f "$HOME/.profile" ] || printf '%s\n' "$line" >> "$HOME/.profile"
}

main "$@"
