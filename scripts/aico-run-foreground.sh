#!/usr/bin/env bash
# Foreground runner for systemd. Unlike aico-launch.sh, this does not fork away:
# systemd tracks this process, while the pidfile still names the process group
# so aico-stop.sh can tear down the whole Electron/sidecar tree safely.
set -euo pipefail

# Optional local agent launcher wrappers may live in ~/.claude/bin or
# ~/.codex/bin. Keep common user bin paths ahead of system paths without making
# those wrappers required.
export PATH="$HOME/.claude/bin:$HOME/.codex/bin:/usr/local/bin:$PATH"

REPO="${AICO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/aico"
PIDFILE="$LOG_DIR/aico.pid"
mkdir -p "$LOG_DIR"

# Same cmdline/cwd guard the launcher and stopper use: the pidfile survives a
# reboot, so a bare `kill -0` on it can match a recycled PID and wrongly declare
# Aico "already running" forever. Confirm the live pid is actually our app tree.
is_aico_process() {
  local pid="$1"
  local cmd cwd

  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"

  case "$cmd" in
    *"$REPO"*) return 0 ;;
  esac

  if [ "$cwd" = "$REPO" ]; then
    case "$cmd" in
      *electron*|*node*|*npm*|*bash*) return 0 ;;
    esac
  fi

  return 1
}

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null && is_aico_process "$PID"; then
    echo "aico-run-foreground: already running (pid $PID)" >&2
    exit 0
  fi
  echo "aico-run-foreground: clearing stale pidfile (pid '$PID' is not a live Aico)" >&2
fi
rm -f "$PIDFILE"

# Build with electron-vite, then exec bare electron — same env-hygiene rationale
# as aico-launch.sh: keeping electron-vite (`npm start` -> preview) out of the
# runtime parent means electron, and the tmux panes and sidecar it spawns,
# inherit a clean env instead of npm's build-time pollution. `exec` keeps the
# pidfile's pid valid (electron replaces this bash in place).
exec setsid --wait bash -c '
  set -euo pipefail
  pidfile="$1"
  repo="$2"
  echo $$ >"$pidfile"
  cd "$repo"
  npm run build
  exec ./node_modules/.bin/electron .
' bash "$PIDFILE" "$REPO"
