#!/usr/bin/env bash
# Release gate: exercise the AppImage itself, with a private display, bus, and home.
set -euo pipefail

if [[ $# -ne 1 || ! -f $1 ]]; then
  echo 'Usage: aico-packaged-smoke.sh path/to/Aico-*.AppImage' >&2
  exit 2
fi
artifact=$(realpath -- "$1")

if [[ ${AICO_PACKAGED_SMOKE_IN_XVFB:-} != 1 ]]; then
  # Never inherit a developer/runner display or session bus into this check.
  outer_tmp=$(mktemp -d)
  trap 'rm -rf -- "$outer_tmp"' EXIT
  mkdir -p "$outer_tmp/home" "$outer_tmp/config" "$outer_tmp/cache" \
    "$outer_tmp/data" "$outer_tmp/state" "$outer_tmp/runtime"
  chmod 700 "$outer_tmp/runtime"
  timeout --signal=TERM --kill-after=5s 240s \
    env -i PATH="$PATH" LANG=C.UTF-8 HOME="$outer_tmp/home" \
    XDG_CONFIG_HOME="$outer_tmp/config" XDG_CACHE_HOME="$outer_tmp/cache" \
    XDG_DATA_HOME="$outer_tmp/data" XDG_STATE_HOME="$outer_tmp/state" \
    XDG_RUNTIME_DIR="$outer_tmp/runtime" TMPDIR="$outer_tmp" \
    xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' \
    dbus-run-session -- env AICO_PACKAGED_SMOKE_IN_XVFB=1 bash "$0" "$artifact"
  exit $?
fi

tmp=$(mktemp -d)
primary_pid=
cleanup() {
  status=$?
  trap - EXIT
  if [[ -n $primary_pid ]]; then
    # setsid gives the AppImage launcher, Electron, and helper processes a
    # dedicated process group. Stop that whole group even if the launcher exits.
    kill -TERM -- "-$primary_pid" 2>/dev/null || true
    for ((i = 0; i < 20; i++)); do
      kill -0 -- "-$primary_pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL -- "-$primary_pid" 2>/dev/null || true
    wait "$primary_pid" 2>/dev/null || true
  fi
  if ((status != 0)); then
    echo 'Packaged AppImage smoke failed; Electron/sidecar log follows:' >&2
    if [[ -f $tmp/app.log ]]; then tail -n 120 "$tmp/app.log" >&2; fi
    if [[ -f $tmp/activation.log ]]; then
      echo 'Second-launch log follows:' >&2
      tail -n 40 "$tmp/activation.log" >&2
    fi
  fi
  rm -rf -- "$tmp"
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$tmp/home" "$tmp/config" "$tmp/cache" "$tmp/data" "$tmp/state" "$tmp/runtime" "$tmp/temp"
chmod 700 "$tmp/runtime"
read -r port debug_port < <(python3 - <<'PY'
import socket
with socket.socket() as sidecar, socket.socket() as devtools:
    sidecar.bind(('127.0.0.1', 0))
    devtools.bind(('127.0.0.1', 0))
    print(sidecar.getsockname()[1], devtools.getsockname()[1])
PY
)

# env -i also keeps CI credentials and any local Aico configuration out of the
# packaged process. Only the Xvfb/dbus session and isolated paths are passed in.
app_env=(env -i
  PATH="$PATH"
  HOME="$tmp/home"
  LANG=C.UTF-8
  DISPLAY="$DISPLAY"
  XAUTHORITY="$XAUTHORITY"
  DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"
  XDG_CONFIG_HOME="$tmp/config"
  XDG_CACHE_HOME="$tmp/cache"
  XDG_DATA_HOME="$tmp/data"
  XDG_STATE_HOME="$tmp/state"
  XDG_RUNTIME_DIR="$tmp/runtime"
  TMPDIR="$tmp/temp"
  AICO_STATE_DIR="$tmp/state/aico"
  AICO_SIDECAR_HOST=127.0.0.1
  AICO_SIDECAR_PORT="$port"
  APPIMAGE_EXTRACT_AND_RUN=1)

setsid "${app_env[@]}" "$artifact" --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-address=127.0.0.1 "--remote-debugging-port=$debug_port" \
  >"$tmp/app.log" 2>&1 &
primary_pid=$!

health_ok() {
  python3 - "$port" <<'PY'
import json
import sys
import urllib.request

try:
    with urllib.request.urlopen(
        f'http://127.0.0.1:{sys.argv[1]}/health', timeout=1
    ) as response:
        body = json.load(response)
    ok = body.get('status') == 'ok' and body.get('service') == 'aico-sidecar'
except (OSError, ValueError, TypeError):
    ok = False
sys.exit(0 if ok else 1)
PY
}

deadline=$((SECONDS + 90))
until health_ok && grep -q '\[aico\] sidecar ready:' "$tmp/app.log"; do
  if ! kill -0 "$primary_pid" 2>/dev/null; then
    echo 'AppImage exited before its bundled sidecar became ready' >&2
    exit 1
  fi
  if ((SECONDS >= deadline)); then
    echo 'Timed out waiting for the bundled sidecar health gate' >&2
    exit 1
  fi
  sleep 0.5
done
echo 'Bundled sidecar returned the expected health identity and Electron reported ready.'

# A fresh Aico profile starts in the tray. The second launch activates the
# first instance and creates a shell widget. It gets its own TMPDIR: with
# APPIMAGE_EXTRACT_AND_RUN the runtime deletes its extraction directory on exit,
# and a shared one would vanish under the primary's running sidecar.
mkdir -p "$tmp/temp-second"
timeout --signal=TERM --kill-after=5s 30s \
  "${app_env[@]}" TMPDIR="$tmp/temp-second" "$artifact" --no-sandbox --disable-gpu --disable-dev-shm-usage \
  >"$tmp/activation.log" 2>&1 || {
    echo 'Second AppImage launch failed to activate the first instance' >&2
    cat "$tmp/activation.log" >&2
    exit 1
  }

deadline=$((SECONDS + 60))
widget_window_ok() {
  # The tray creates tiny Aico X windows too. Require a native widget-sized
  # top-level window, not merely the 10x10 tray/helper surfaces.
  xwininfo -root -tree 2>/dev/null | awk '
    tolower($0) ~ /\("aico" "aico"\)/ {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^[0-9]+x[0-9]+[+-]/) {
          split($i, dimensions, /[x+-]/)
          if (dimensions[1] >= 360 && dimensions[2] >= 240) found = 1
        }
      }
    }
    END { exit !found }
  '
}
until widget_window_ok; do
  if ! kill -0 "$primary_pid" 2>/dev/null; then
    echo 'AppImage exited before creating an Aico window' >&2
    exit 1
  fi
  if ((SECONDS >= deadline)); then
    echo 'Timed out waiting for an Aico window on Xvfb' >&2
    xwininfo -root -tree >&2 || true
    exit 1
  fi
  sleep 0.5
done

# Inspect the packaged renderer over Chromium's local DevTools endpoint. This
# checks the preload, mounted terminal, populated control surface, and its click
# handler; the X window alone could exist with broken renderer JavaScript.
timeout --signal=TERM --kill-after=5s 40s \
  node "$(dirname "$0")/aico-packaged-smoke-cdp.mjs" "$debug_port"

# Ensure the native window stays up after the renderer probe.
if ! kill -0 "$primary_pid" 2>/dev/null || ! widget_window_ok; then
  echo 'Packaged Aico window did not remain open' >&2
  exit 1
fi
health_ok || { echo 'Bundled sidecar became unhealthy after widget activation' >&2; exit 1; }
# Icons load from inside app.asar; a bad path yields an empty image, not an error.
widget_icon_ok() {
  local id icon
  for id in $(xwininfo -root -tree 2>/dev/null | awk 'tolower($0) ~ /\("aico" "aico"\)/ {print $1}'); do
    # Read the raw CARDINALs (width, height, pixels...); xprop's default icon
    # rendering prints nothing off a terminal.
    icon=$(xprop -id "$id" -f _NET_WM_ICON 32c -len 64 _NET_WM_ICON 2>/dev/null || true)
    [[ $icon =~ =\ [1-9][0-9]*,\ [1-9][0-9]* ]] && return 0
  done
  return 1
}
widget_icon_ok || { echo 'Packaged widget window has no _NET_WM_ICON' >&2; exit 1; }
if grep -q '\[aico\] tray icon failed to load' "$tmp/app.log"; then
  echo 'Packaged tray icon failed to load' >&2
  exit 1
fi
if grep -Eq '\[aico:renderer\].*( error |load failed|process gone)' "$tmp/app.log"; then
  echo 'Packaged renderer logged an error, load failure, or crash' >&2
  exit 1
fi
echo 'Packaged Electron renderer and control surface are ready on Xvfb; sidecar remains healthy.'
