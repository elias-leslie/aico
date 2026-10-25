#!/usr/bin/env bash
# Foreground runner for systemd. It never detaches: the script, build, Electron,
# and Chromium helpers all remain in the exact service cgroup. The
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
READYFILE="$LOG_DIR/activation.ready"
LOCKFILE="$LOG_DIR/aico.lock"
RUNTIME_UNIT="${AICO_RUNTIME_UNIT:-aico-shell.service}"
mkdir -p "$LOG_DIR"
cd "$REPO"

if [ "$RUNTIME_UNIT" != aico-shell.service ]; then
  echo "aico-run-foreground: refusing unknown runtime unit '$RUNTIME_UNIT'" >&2
  exit 1
fi
if [ "${AICO_OWNER:-}" != aico ] || [ "${AICO_WORKLOAD_CLASS:-}" != desktop-runtime ]; then
  echo "aico-run-foreground: required desktop-runtime ownership markers are missing" >&2
  exit 1
fi

# Fail closed if this script was invoked directly or systemd placed it somewhere
# unexpected. The supported launchers start only this exact user service;
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
rm -f "$READYFILE"

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

# `st service rebuild` builds out/ when it stages a release
# (<state>/releases/<32-hex build id>/source, no .git), so starting from that
# release reuses its build. A source checkout always rebuilds: its out/ can lag
# the working tree.
prebuilt_release() {
  local build_id
  case "$REPO" in */releases/*/source) ;; *) return 1 ;; esac
  build_id="$(basename "$(dirname "$REPO")")"
  [[ "$build_id" =~ ^[0-9a-f]{32}$ ]] || return 1
  [ ! -e "$REPO/.git" ] || return 1
  [ -s "$REPO/out/main/index.js" ] && [ -s "$REPO/out/preload/index.cjs" ] &&
    [ -s "$REPO/out/renderer/index.html" ]
}

# Build with electron-vite, then exec the Electron binary directly. The package
# shim is a Node launcher which spawns the real binary; using it would leave the
# shim as systemd's MainPID while Electron can move its own PID into a desktop
# application scope. A stop would then signal the shim instead of the process
# that owns the windows. Direct exec preserves this PID across the transition,
# so systemd keeps exact authority over Electron even if the desktop reclassifies
# its MainPID. No setsid is needed inside a systemd service: KillMode=mixed is
# the whole-runtime boundary and fd 9 keeps the launch lock until Electron exits.
if prebuilt_release; then
  echo "aico-run-foreground: using the release build" >&2
else
  npm run build:desktop
fi
export PATH="$RUNTIME_PATH"
export AICO_ACTIVATION_READY_FILE="$READYFILE"
# Electron keeps this shell's PID across exec; it clears the pidfile on a clean
# quit while the file still names it.
export AICO_PIDFILE="$PIDFILE"
# Aico is a native Wayland client: under Xwayland (before explicit sync) NVIDIA
# showed stale frames, so typed text vanished and came back. AICO_OZONE_PLATFORM=x11
# forces Xwayland. AICO_CHROMIUM_FLAGS adds Chromium switches (space-separated).
read -r -a chromium_flags <<<"${AICO_CHROMIUM_FLAGS:-}"
# Xwayland hands GNOME's text scaling to Chromium as Xft.dpi; native Wayland
# Chromium ignores it. Apply it as the device scale so text keeps its size.
if [ "${AICO_OZONE_PLATFORM:-wayland}" = wayland ]; then
  text_scale="$(gsettings get org.gnome.desktop.interface text-scaling-factor 2>/dev/null || echo 1.0)"
  case "$text_scale" in
    1 | 1.0) ;;
    *[!0-9.]* | '') echo "aico-run-foreground: ignoring text scale '$text_scale'" >&2 ;;
    *) chromium_flags+=("--force-device-scale-factor=$text_scale") ;;
  esac
fi
exec ./node_modules/electron/dist/electron . "--ozone-platform=${AICO_OZONE_PLATFORM:-wayland}" "${chromium_flags[@]}"
