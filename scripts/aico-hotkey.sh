#!/usr/bin/env bash
# The Indicate selection hotkey on GNOME/Wayland. Electron's globalShortcut goes
# through an xdg-desktop-portal session that GNOME asks the owner to approve per
# app and that Aico cannot see the outcome of; a GNOME custom shortcut running
# `aico-launch.sh --indicate` is deterministic. The launcher delivers
# --aico-indicate to the running Aico (second-instance), which harvests the
# selection. Rerunning changes only what differs.
#
#   scripts/aico-hotkey.sh install [ACCELERATOR]   default: AICO_SELECTION_HOTKEY or
#                                                  CommandOrControl+Shift+Space
#   scripts/aico-hotkey.sh remove
#   scripts/aico-hotkey.sh status
#
# ACCELERATOR is an Electron accelerator (CommandOrControl+Shift+Space) or a GTK
# one (<Control><Shift>space). GSETTINGS_BACKEND=keyfile points the whole script
# at a scratch settings file for tests.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA=org.gnome.settings-daemon.plugins.media-keys
KEY=custom-keybindings
SLOT=aico-indicate
SLOT_PATH="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/$SLOT/"
SLOT_SCHEMA="$SCHEMA.custom-keybinding:$SLOT_PATH"

command -v gsettings >/dev/null 2>&1 || {
  echo "aico-hotkey: gsettings is required (GNOME)" >&2
  exit 1
}

# Electron accelerator to GTK accelerator.
to_gtk() {
  local accelerator="$1"
  case "$accelerator" in
    *"<"*) printf '%s\n' "$accelerator"; return ;;
  esac
  local out="" part
  local IFS='+'
  local -a parts
  read -r -a parts <<<"$accelerator"
  for part in "${parts[@]}"; do
    case "${part,,}" in
      commandorcontrol | cmdorctrl | control | ctrl) out+="<Control>" ;;
      shift) out+="<Shift>" ;;
      alt | option) out+="<Alt>" ;;
      super | meta | command | cmd) out+="<Super>" ;;
      space) out+="space" ;;
      *) out+="${part,,}" ;;
    esac
  done
  printf '%s\n' "$out"
}

# The custom-keybindings list with SLOT_PATH added (add) or removed (remove).
rewrite_list() {
  local mode="$1" current
  current="$(gsettings get "$SCHEMA" "$KEY")"
  python3 -I - "$mode" "$SLOT_PATH" "$current" <<'PY'
import ast, sys
mode, slot, raw = sys.argv[1:4]
raw = raw.strip()
if raw.startswith("@as"):
    raw = raw[3:].strip()
items = [p for p in ast.literal_eval(raw or "[]") if p != slot]
if mode == "add":
    items.append(slot)
print("[" + ", ".join(repr(p) for p in items) + "]")
PY
}

case "${1:-status}" in
  install)
    accelerator="${2:-${AICO_SELECTION_HOTKEY:-CommandOrControl+Shift+Space}}"
    binding="$(to_gtk "$accelerator")"
    gsettings set "$SCHEMA" "$KEY" "$(rewrite_list add)"
    gsettings set "$SLOT_SCHEMA" name 'Aico: Indicate selection'
    gsettings set "$SLOT_SCHEMA" command "$REPO/scripts/aico-launch.sh --indicate"
    gsettings set "$SLOT_SCHEMA" binding "$binding"
    echo "aico-hotkey: $binding runs $REPO/scripts/aico-launch.sh --indicate"
    ;;
  remove)
    gsettings set "$SCHEMA" "$KEY" "$(rewrite_list remove)"
    gsettings reset-recursively "$SLOT_SCHEMA" 2>/dev/null || true
    echo "aico-hotkey: removed"
    ;;
  status)
    if gsettings get "$SCHEMA" "$KEY" | grep -Fq "$SLOT_PATH"; then
      echo "aico-hotkey: installed: $(gsettings get "$SLOT_SCHEMA" binding) runs $(gsettings get "$SLOT_SCHEMA" command)"
    else
      echo "aico-hotkey: not installed"
      exit 1
    fi
    ;;
  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
