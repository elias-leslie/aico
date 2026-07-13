#!/usr/bin/env bash
# Aico dev launcher. Wired to ~/.local/share/applications/aico.desktop so a
# taskbar/app-grid click builds the repo and runs the built (prod) app — always
# the latest code. Output is appended to the launcher log for debugging.
#
# The app tree (Electron + helpers + Python sidecar) runs in the canonical
# managed `aico-shell.service`. The .desktop launcher imports only its explicit
# graphical-session variables and starts that same unit instead of inventing a
# second transient runtime. This keeps `st service rebuild`, desktop clicks, and
# operator stop actions on one ownership boundary, separate from durable tmux
# server/pane units.
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
# Use only trusted system locations for containment and identity commands. The
# managed unit defines Electron's runtime PATH itself.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO="${AICO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/aico"
PIDFILE="$LOG_DIR/aico.pid"
RUNTIME_UNIT="aico-shell.service"
mkdir -p "$LOG_DIR"
cd "$REPO"

# Serialize concurrent launches. A double-click / .desktop StartupNotify can fire
# this twice in quick succession; without a lock both invocations pass the
# "already running" guard below before either child writes the pidfile, so both
# spawn full app trees and the 2nd `echo $$` orphans the 1st process group. Hold
# an flock across the guard, then hand startup to aico-run-foreground.sh, which
# takes the same lock before writing the pidfile. A fixed transient unit name is
# the second arbitration boundary in the small handoff window between the two.
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

# GNOME may move Electron's window-owning PID into a PID-derived application
# scope even though that same PID remains the canonical service's MainPID. Treat
# only that exact, systemd-corroborated scope as part of the runtime boundary.
# An arbitrary app-* scope is never sufficient ownership evidence.
process_is_tracked_aico_application_scope() {
  local pid="$1"
  local process_control_group="$2"
  local unit="app-aico-${pid}.scope"
  local expected="/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/$unit"
  local properties load_state active_state control_group

  [ "$process_control_group" = "$expected" ] || return 1
  properties="$(
    systemctl --user show "$unit" --no-pager \
      --property=LoadState \
      --property=ActiveState \
      --property=ControlGroup 2>/dev/null
  )" || return 1
  load_state="$(awk -F= '$1 == "LoadState" { print $2; exit }' <<<"$properties")"
  active_state="$(awk -F= '$1 == "ActiveState" { print $2; exit }' <<<"$properties")"
  control_group="$(awk -F= '$1 == "ControlGroup" { print $2; exit }' <<<"$properties")"
  [ "$load_state" = loaded ] || return 1
  case "$active_state" in active | activating | reloading | deactivating) ;; *) return 1 ;; esac
  [ "$control_group" = "$expected" ] || return 1
  grep -Fxq "$pid" "/sys/fs/cgroup$expected/cgroup.procs" 2>/dev/null
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

# The installed managed unit is the only supported desktop runtime. Refuse a
# direct/uncontained fallback if install or user-manager integration is missing.
if ! command -v systemctl >/dev/null 2>&1; then
  echo "aico-launch: systemctl is required for exact whole-runtime containment" >&2
  exit 1
fi
UNIT_FRAGMENT="$(systemctl --user show "$RUNTIME_UNIT" --property=FragmentPath --value 2>/dev/null || true)"
if [ -z "$UNIT_FRAGMENT" ] || [ ! -f "$UNIT_FRAGMENT" ]; then
  echo "aico-launch: managed unit $RUNTIME_UNIT is not installed; run scripts/aico-install.sh" >&2
  exit 1
fi
if [ -z "${DISPLAY:-}" ]; then
  echo "aico-launch: DISPLAY is missing; refusing graphical launch" >&2
  exit 1
fi

# GNOME starts default.target before its graphical environment is guaranteed to
# be in the user manager. Import only display/session routing values supplied by
# this already-running desktop process; never import arbitrary project or agent
# environment into the service or durable tmux sessions.
declare -a graphical_environment=(DISPLAY)
for name in XAUTHORITY WAYLAND_DISPLAY XDG_SESSION_TYPE; do
  if [ -n "${!name:-}" ]; then graphical_environment+=("$name"); fi
done
systemctl --user import-environment "${graphical_environment[@]}"

# The managed foreground runner owns the pidfile transaction. Release our copy
# immediately before activation; a racing launcher can at worst observe the
# same idempotent fixed-unit start, never create a second runtime.
flock -u 9
exec 9>&-
systemctl --user reset-failed "$RUNTIME_UNIT" 2>/dev/null || true
systemctl --user start "$RUNTIME_UNIT"

# The runner writes its pid under the shared lock before `npm run build`, so this
# registration normally resolves in milliseconds. Bound the observation so a
# failed runner cannot leave the desktop launcher hanging indefinitely.
for _ in $(seq 1 50); do
  if [ -s "$PIDFILE" ]; then break; fi
  sleep 0.1
done

if [ ! -s "$PIDFILE" ]; then
  echo "aico-launch: runtime did not register a pid; inspect $LOG_DIR/launcher.log" >&2
  exit 1
fi
PID="$(cat "$PIDFILE" 2>/dev/null || true)"
if ! [[ "$PID" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$PID" 2>/dev/null || ! is_aico_process "$PID"; then
  echo "aico-launch: runtime pid registration is invalid or already exited (pid '$PID')" >&2
  exit 1
fi

# Do not accept another launch model's pidfile as proof that the managed unit
# started. MainPID plus either the exact user-service cgroup or the exact,
# PID-derived GNOME application scope is the startup boundary.
UNIT_MAIN_PID="$(systemctl --user show "$RUNTIME_UNIT" --property=MainPID --value 2>/dev/null || true)"
UNIT_CONTROL_GROUP="$(systemctl --user show "$RUNTIME_UNIT" --property=ControlGroup --value 2>/dev/null || true)"
EXPECTED_CONTROL_GROUP="/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/$RUNTIME_UNIT"
PROCESS_CONTROL_GROUP="$(awk -F: '$1 == "0" && $2 == "" { print $3; exit }' "/proc/$PID/cgroup" 2>/dev/null || true)"
if [ "$UNIT_MAIN_PID" != "$PID" ] || [ "$UNIT_CONTROL_GROUP" != "$EXPECTED_CONTROL_GROUP" ] ||
  { [ "$PROCESS_CONTROL_GROUP" != "$UNIT_CONTROL_GROUP" ] &&
    ! process_is_tracked_aico_application_scope "$PID" "$PROCESS_CONTROL_GROUP"; }; then
  echo "aico-launch: refusing unverified runtime registration for $RUNTIME_UNIT (pid '$PID')" >&2
  exit 1
fi
echo "aico-launch: started; pidfile $PIDFILE, log $LOG_DIR/launcher.log" >&2
