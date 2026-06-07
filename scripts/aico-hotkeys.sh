#!/usr/bin/env bash
# Aico desktop-grab hotkeys (GNOME/X11). Registers two global shortcuts that
# fire scripts/aico-grab.sh — the gesture, which is itself pure `st` composition.
# This script only wires keys to it; it adds no capture logic of its own.
#
#   aico-hotkeys.sh install   # bind the shortcuts (idempotent)
#   aico-hotkeys.sh remove    # unbind them
#   aico-hotkeys.sh status    # show current binding state
#
# Bindings:
#   Super+Shift+G  → package focused window (image+text+meta)  (aico-grab.sh)
#   Super+Shift+T  → grab focused window as OCR text only       (aico-grab.sh -t)
#   Super+Shift+W  → click any window to package it             (aico-grab.sh -p)
#   Super+Shift+R  → drag-select a region as a package           (aico-grab.sh -r)
#
# The commands use AICO_DISPLAY, the current DISPLAY, or :0 and put common user
# bin paths on PATH, since GNOME spawns keybinding commands with a minimal
# environment. The grab commands require the optional `st` capture tooling.
set -euo pipefail

GRAB="${AICO_GRAB:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/aico-grab.sh}"
AICO_DISPLAY="${AICO_DISPLAY:-${DISPLAY:-:0}}"
SCHEMA="org.gnome.settings-daemon.plugins.media-keys"
ITEM="org.gnome.settings-daemon.plugins.media-keys.custom-keybinding"
BASE="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings"

# path | display name | binding | grab args
ENTRIES=(
  "$BASE/aico-grab-image/|Aico grab (package)|<Super><Shift>g|"
  "$BASE/aico-grab-text/|Aico grab (text)|<Super><Shift>t|-t"
  "$BASE/aico-grab-pick/|Aico grab (pick window)|<Super><Shift>w|-p"
  "$BASE/aico-grab-region/|Aico grab (region)|<Super><Shift>r|-r"
)

cmd_for() { # args -> the command string GNOME will run
  local args="$1"
  printf 'bash -c '\''PATH="$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH" DISPLAY=%s exec %s%s'\''' \
    "$AICO_DISPLAY" "$GRAB" "${args:+ $args}"
}

# Rewrite the custom-keybindings list = existing ∪/∖ our paths.
set_list() { # mode(add|del) path...
  local mode="$1"; shift
  local current; current="$(gsettings get "$SCHEMA" custom-keybindings)"
  python3 - "$mode" "$current" "$@" <<'PY'
import ast, sys
mode, current, *ours = sys.argv[1:]
try:
    lst = ast.literal_eval(current) if current.strip() not in ("@as []", "[]") else []
except (ValueError, SyntaxError):
    lst = []
lst = [p for p in lst if p not in ours]
if mode == "add":
    lst += ours
print("[" + ", ".join("'%s'" % p for p in lst) + "]")
PY
}

install() {
  local paths=()
  for e in "${ENTRIES[@]}"; do
    IFS='|' read -r path name binding args <<<"$e"
    paths+=("$path")
    gsettings set "$ITEM:$path" name "$name"
    gsettings set "$ITEM:$path" command "$(cmd_for "$args")"
    gsettings set "$ITEM:$path" binding "$binding"
  done
  gsettings set "$SCHEMA" custom-keybindings "$(set_list add "${paths[@]}")"
  echo "installed:"
  status
}

remove() {
  local paths=()
  for e in "${ENTRIES[@]}"; do
    IFS='|' read -r path _ _ _ <<<"$e"
    paths+=("$path")
    gsettings reset-recursively "$ITEM:$path" 2>/dev/null || true
  done
  gsettings set "$SCHEMA" custom-keybindings "$(set_list del "${paths[@]}")"
  echo "removed. list now: $(gsettings get "$SCHEMA" custom-keybindings)"
}

status() {
  echo "list: $(gsettings get "$SCHEMA" custom-keybindings)"
  for e in "${ENTRIES[@]}"; do
    IFS='|' read -r path _ _ _ <<<"$e"
    printf '  %s\n    binding=%s\n    command=%s\n' \
      "$path" \
      "$(gsettings get "$ITEM:$path" binding 2>/dev/null || echo '(unset)')" \
      "$(gsettings get "$ITEM:$path" command 2>/dev/null || echo '(unset)')"
  done
}

case "${1:-status}" in
  install) install ;;
  remove)  remove ;;
  status)  status ;;
  *) echo "usage: aico-hotkeys.sh {install|remove|status}" >&2; exit 2 ;;
esac
