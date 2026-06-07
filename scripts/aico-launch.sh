#!/usr/bin/env bash
# Aico dev launcher. Wired to ~/.local/share/applications/aico.desktop so a
# taskbar/app-grid click builds the repo and runs the built (prod) app — always
# the latest code. Output is appended to the launcher log for debugging.
#
# The app tree (electron + Python sidecar) is launched in a NEW SESSION whose
# leader PID is recorded in a pidfile, so scripts/aico-stop.sh can tear down
# exactly the process group we started and nothing else. Stopping Aico by an
# window-derived PGID can hit the wrong desktop process; always go through the
# pidfile.
#
# We build with electron-vite, then exec the built app with bare `electron`
# rather than `electron-vite preview` (i.e. `npm start`). Keeping electron-vite
# out of the RUNTIME parent means electron inherits this clean GNOME-session env
# instead of npm's build-time pollution (NODE_ENV=production, every npm_* var, a
# node_modules/.bin-prefixed PATH). That env is otherwise captured by tmux at
# session-create and leaks into every terminal pane — silently breaking work in
# OTHER projects (vitest loads prod React, `npm ci` drops devDeps, bare tsc/
# vitest resolve to Aico's bundled copies). Build-first preserves "click = latest
# code"; the PTY's `env: process.env` then forwards a clean env, no code needed.
set -euo pipefail

# GNOME launches .desktop entries with a minimal PATH; node/npm live here.
# Optional local agent launcher wrappers may live in ~/.claude/bin or
# ~/.codex/bin. Keep common user bin paths ahead of system paths without making
# those wrappers required.
export PATH="$HOME/.claude/bin:$HOME/.codex/bin:/usr/local/bin:$PATH"

REPO="${AICO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/aico"
PIDFILE="$LOG_DIR/aico.pid"
mkdir -p "$LOG_DIR"
cd "$REPO"

# Serialize concurrent launches. A double-click / .desktop StartupNotify can fire
# this twice in quick succession; without a lock both invocations pass the
# "already running" guard below before either child writes the pidfile, so both
# spawn full app trees and the 2nd `echo $$` orphans the 1st process group. Hold
# an flock across the guard AND until the child has registered its pid (loop at
# the end), so a racing launcher either fails the lock or sees a populated
# pidfile. The lock is dropped when this script exits; the child does not inherit
# fd 9 (9>&- on the spawn) so the long-lived app never keeps the lock held.
exec 9>"$LOG_DIR/aico.lock"
if ! flock -n 9; then
  echo "aico-launch: another launch is already in progress; aborting" >&2
  exit 1
fi

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

# One instance at a time: bail if a recorded pid is still alive.
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if ! [[ "$PID" =~ ^[0-9]+$ ]]; then
    echo "aico-launch: pidfile has no valid pid; clearing" >&2
    rm -f "$PIDFILE"
  elif kill -0 "$PID" 2>/dev/null; then
    if is_aico_process "$PID"; then
      echo "aico-launch: already running (pid $PID); run scripts/aico-stop.sh first" >&2
      exit 1
    fi

    CMD="$(tr '\0' ' ' <"/proc/$PID/cmdline" 2>/dev/null || true)"
    echo "aico-launch: clearing stale pidfile; pid $PID is not Aico: [$CMD]" >&2
    rm -f "$PIDFILE"
  else
    echo "aico-launch: clearing stale pidfile for exited pid $PID" >&2
    rm -f "$PIDFILE"
  fi
fi

# setsid => the whole tree shares one process group we own. The child writes its
# own pid ($$ == new session leader == process-group id) so aico-stop.sh can
# group-kill precisely that, never a window we didn't launch. The build runs as a
# child first (its env pollution stays contained); then `exec electron` replaces
# this bash in place, keeping the same pid/group while inheriting the clean env.
setsid bash -c 'echo $$ >"'"$PIDFILE"'"; npm run build && exec ./node_modules/.bin/electron .' >>"$LOG_DIR/launcher.log" 2>&1 9>&- &

# Hold the launch lock until the child has registered its pid, so a racing
# launcher that then acquires the lock sees the running instance via the guard
# above (and bails) rather than spawning a duplicate. The child writes its pid
# before `npm run build`, so this resolves in milliseconds.
for _ in $(seq 1 50); do
  if [ -s "$PIDFILE" ]; then break; fi
  sleep 0.1
done
echo "aico-launch: started; pidfile $PIDFILE, log $LOG_DIR/launcher.log" >&2
