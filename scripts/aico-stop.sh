#!/usr/bin/env bash
# Stop Aico by the process group recorded in the launcher pidfile — and ONLY that
# group. This script never derives a target from window state: it trusts the
# pidfile written by aico-launch.sh and guards the cmdline before killing.
set -euo pipefail

LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/aico"
PIDFILE="$LOG_DIR/aico.pid"
REPO="${AICO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

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

if [ ! -f "$PIDFILE" ]; then
  echo "aico-stop: no pidfile at $PIDFILE; nothing to stop" >&2
  exit 0
fi

PID="$(cat "$PIDFILE" 2>/dev/null || true)"
if ! [[ "$PID" =~ ^[0-9]+$ ]]; then
  echo "aico-stop: pidfile has no valid pid; removing" >&2
  rm -f "$PIDFILE"
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  echo "aico-stop: pid $PID not running; clearing stale pidfile" >&2
  rm -f "$PIDFILE"
  exit 0
fi

# Safety guard: the recorded leader must look like our app tree, never anything
# else. Clear reused/stale pidfiles rather than risk a stray group-kill.
CMD="$(tr '\0' ' ' <"/proc/$PID/cmdline" 2>/dev/null || true)"
if ! is_aico_process "$PID"; then
  echo "aico-stop: pidfile points to non-Aico pid $PID; clearing stale pidfile: [$CMD]" >&2
  rm -f "$PIDFILE"
  exit 0
fi

echo "aico-stop: SIGTERM process group $PID ($CMD)" >&2
kill -TERM -- "-$PID" 2>/dev/null || true

# Grace period, then SIGKILL any survivors in the group.
for _ in $(seq 1 10); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.3
done
if kill -0 "$PID" 2>/dev/null; then
  echo "aico-stop: group still alive after SIGTERM; SIGKILL" >&2
  kill -KILL -- "-$PID" 2>/dev/null || true
fi

rm -f "$PIDFILE"
echo "aico-stop: stopped" >&2
