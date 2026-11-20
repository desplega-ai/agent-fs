#!/bin/sh
# agent-fs one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/desplega-ai/agent-fs/main/scripts/install.sh | sh
#
# Installs bun if missing, then the agent-fs CLI, then on macOS mounts your
# drive at ~/agent-fs on every login (`agent-fs mount --install`).
#
# Env:
#   AGENT_FS_VERSION=0.19.0     npm version to install (default: latest)
#   AGENT_FS_BRANCH=<branch>    build that git branch from source instead (pre-release testing)
#   AGENT_FS_SRC=<dir>          where the branch checkout lives (default: ~/.agent-fs-src)
#   AGENT_FS_MOUNT=<dir>        mountpoint (default: ~/agent-fs)
#   AGENT_FS_NO_MOUNT=1         install the CLI only
set -eu

say() { printf '==> %s\n' "$*"; }

if ! command -v bun >/dev/null 2>&1; then
  if [ ! -x "$HOME/.bun/bin/bun" ]; then
    say "Installing bun (agent-fs runs on bun)"
    curl -fsSL https://bun.sh/install | bash
  fi
  PATH="$HOME/.bun/bin:$PATH"
  export PATH
fi
BUN="$(command -v bun)"

if [ -n "${AGENT_FS_BRANCH:-}" ]; then
  SRC="${AGENT_FS_SRC:-$HOME/.agent-fs-src}"
  say "Building agent-fs from branch $AGENT_FS_BRANCH in $SRC"
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" fetch -q origin "$AGENT_FS_BRANCH"
    git -C "$SRC" checkout -q -B "$AGENT_FS_BRANCH" FETCH_HEAD
  else
    git clone -q --branch "$AGENT_FS_BRANCH" https://github.com/desplega-ai/agent-fs "$SRC"
  fi
  (cd "$SRC" && "$BUN" install --frozen-lockfile && "$BUN" run build)
  mkdir -p "$HOME/.bun/bin"
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$BUN" "$SRC/packages/cli/dist/cli.js" > "$HOME/.bun/bin/agent-fs"
  chmod +x "$HOME/.bun/bin/agent-fs"
else
  say "Installing @desplega.ai/agent-fs@${AGENT_FS_VERSION:-latest}"
  "$BUN" add -g "@desplega.ai/agent-fs@${AGENT_FS_VERSION:-latest}"
fi
PATH="$HOME/.bun/bin:$PATH"
export PATH
say "agent-fs $(agent-fs --version) installed at $(command -v agent-fs)"

if [ -n "${AGENT_FS_NO_MOUNT:-}" ] || [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

if ! agent-fs auth whoami >/dev/null 2>&1; then
  say "agent-fs is not connected to a server yet. Connect it, then run: agent-fs mount --install"
  echo "    agent-fs config set apiUrl <https://your-agent-fs-server>"
  echo "    agent-fs config set apiKey <your API key>"
  exit 0
fi

say "Mounting your drive at ${AGENT_FS_MOUNT:-$HOME/agent-fs} on every login"
agent-fs mount "${AGENT_FS_MOUNT:-$HOME/agent-fs}" --install
