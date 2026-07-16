#!/usr/bin/env bash
# Foreground runner for systemd. It never detaches: the script, build, Electron,
# Chromium helpers, and sidecar all remain in the exact service cgroup. The
# pidfile names systemd's MainPID so aico-stop.sh can prove unit ownership.
set -euo pipefail

# Preserve the agent-wrapper PATH for Electron, but run lifecycle checks and the
# build through trusted system tool locations. npm adds this repo's
# node_modules/.bin for its build script itself.
RUNTIME_PATH="$HOME/.claude/bin:$HOME/.codex/bin:/usr/local/bin:$PATH"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO="${AICO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/aico"
PIDFILE="$LOG_DIR/aico.pid"
LOCKFILE="$LOG_DIR/aico.lock"
RUNTIME_UNIT="${AICO_RUNTIME_UNIT:-aico-shell.service}"
mkdir -p "$LOG_DIR"
cd "$REPO"

case "$RUNTIME_UNIT" in
  aico-shell.service|aico-shell-runtime.service) ;;
  *)
    echo "aico-run-foreground: refusing unknown runtime unit '$RUNTIME_UNIT'" >&2
    exit 1
    ;;
esac
if [ "${AICO_OWNER:-}" != aico ] || [ "${AICO_WORKLOAD_CLASS:-}" != desktop-runtime ]; then
  echo "aico-run-foreground: required desktop-runtime ownership markers are missing" >&2
  exit 1
fi

# Fail closed if this script was invoked directly or systemd placed it somewhere
# unexpected. The supported launchers create only these two exact user services;
# durable tmux scopes necessarily have a different cgroup leaf.
EXPECTED_CONTROL_GROUP="/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/$RUNTIME_UNIT"
PROCESS_CONTROL_GROUP="$(awk -F: '$1 == "0" && $2 == "" { print $3; exit }' "/proc/$$/cgroup" 2>/dev/null || true)"
if [ "$PROCESS_CONTROL_GROUP" != "$EXPECTED_CONTROL_GROUP" ]; then
  echo "aico-run-foreground: refusing uncontained launch from '$PROCESS_CONTROL_GROUP'" >&2
  exit 1
fi

# Share the launcher's lock across the entire desktop-runtime lifetime. During a
# managed restart, Electron helpers can take a moment to exit and release their
# inherited descriptor after systemd has stopped the old MainPID. Wait briefly
# for that proven teardown race; a genuinely concurrent launcher still fails.
exec 9>"$LOCKFILE"
if ! flock -w 5 9; then
  echo "aico-run-foreground: another Aico launch is in progress" >&2
  exit 1
fi

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
    exit 1
  fi
  echo "aico-run-foreground: clearing stale pidfile (pid '$PID' is not a live Aico)" >&2
fi
rm -f "$PIDFILE"

# Atomic registration prevents the stopper from observing a partially-written
# PID. Remove only our own registration if build/exec fails before Electron
# replaces this shell; a successful exec discards the shell trap automatically.
PREVIOUS_UMASK="$(umask)"
umask 077
PIDFILE_TMP="$PIDFILE.tmp.$$"
printf '%s\n' "$$" >"$PIDFILE_TMP"
mv -f "$PIDFILE_TMP" "$PIDFILE"
umask "$PREVIOUS_UMASK"
cleanup_failed_start() {
  if [ "$(cat "$PIDFILE" 2>/dev/null || true)" = "$$" ]; then rm -f "$PIDFILE"; fi
}
trap cleanup_failed_start EXIT

# Build with electron-vite, then exec the Electron binary directly. The package
# shim is a Node launcher which spawns the real binary; using it would leave the
# shim as systemd's MainPID while Electron can move its own PID into a desktop
# application scope. A stop would then signal the shim instead of the process
# that owns the windows. Direct exec preserves this PID across the transition,
# so systemd keeps exact authority over Electron even if the desktop reclassifies
# its MainPID. No setsid is needed inside a systemd service: KillMode=mixed is
# the whole-runtime boundary and fd 9 keeps the launch lock until Electron exits.
npm run build
export PATH="$RUNTIME_PATH"
exec ./node_modules/electron/dist/electron .
