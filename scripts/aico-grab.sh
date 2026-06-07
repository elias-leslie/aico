#!/usr/bin/env bash
# Aico desktop-grab gesture (X11). Pure composition of canonical `st` verbs —
# it contains NO capture logic of its own (capture lives once, in `st ui`).
# Bind global shortcuts to this.
#
#   aico-grab.sh            # package the focused window → active widget
#   aico-grab.sh aico       # package a window by id / name substring
#   aico-grab.sh -p         # click any window to package it
#   aico-grab.sh -r         # drag-select an arbitrary screen region
#   aico-grab.sh -t [...]   # OCR text only (combine with -p / -r / a name)
#
# The default gesture sends a *package* (`st ui grab`): a directory holding the
# native image, an OCR text transcription, metadata, and an `index.md` that ranks
# those items by token cost. The widget gets the index path, so the agent reads
# the cheap text/meta first and only opens the (expensive, possibly downscaled)
# image when it needs pixel detail — the fix for the "misread a shrunk
# screenshot" problem. `-t` keeps the old lightweight text-only path for when you
# know plain text is all you want.
#
# Pickers (-p `xdotool selectwindow`, -r `slop`) only choose a target id/region;
# capture stays the one `st ui grab` / `st ui shot` surface.
#
# Bind these to global keys with: scripts/aico-hotkeys.sh install
#   Super+Shift+G → package, +T → text, +W → pick window, +R → region.
set -euo pipefail

text=0 pick=0 region=0
while [[ "${1:-}" == -* ]]; do
  case "$1" in
    -t|--text)   text=1 ;;
    -p|--pick)   pick=1 ;;
    -r|--region) region=1 ;;
    *) echo "aico-grab: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# Capture artifacts (screenshots, OCR) hold potentially sensitive screen content,
# so keep them in a private per-user dir (XDG_RUNTIME_DIR is already 0700; the
# /tmp fallback gets chmod 700). The package path must outlive this script (the
# widget reads its index afterwards), so we can't trap-clean it — instead prune
# anything older than 6h on each run, by which point it's long been consumed.
GRAB_BASE="${XDG_RUNTIME_DIR:-/tmp}/aico-grab"
mkdir -p "$GRAB_BASE"
chmod 700 "$GRAB_BASE"
find "$GRAB_BASE" -mindepth 1 -maxdepth 1 -mmin +360 -exec rm -rf {} + 2>/dev/null || true

if [[ $text -eq 1 ]]; then
  # Text-only: capture a throwaway shot, OCR it, send the text. The png is just
  # an intermediate for OCR, so drop it; the snippet is the text itself.
  f="$GRAB_BASE/$$.png"
  if [[ $region -eq 1 ]]; then
    st ui shot --region "$(slop -f '%g')" -o "$f"
  elif [[ $pick -eq 1 ]]; then
    st ui shot -w "$(xdotool selectwindow)" -o "$f"
  elif [[ $# -gt 0 ]]; then
    st ui shot -w "$1" -o "$f"
  else
    st ui shot -o "$f"
  fi
  st ui ocr "$f" | st selection send region --stdin
  rm -f "$f"
  exit 0
fi

# Package path: `st ui grab` writes a directory and prints
#   grab:index=<dir>/index.md|items=N|w=W|h=H|downscaled=<bool>
d="$GRAB_BASE/$$"
if [[ $region -eq 1 ]]; then
  out="$(st ui grab --region "$(slop -f '%g')" -o "$d")"
elif [[ $pick -eq 1 ]]; then
  out="$(st ui grab -w "$(xdotool selectwindow)" -o "$d")"
elif [[ $# -gt 0 ]]; then
  out="$(st ui grab -w "$1" -o "$d")"
else
  out="$(st ui grab -o "$d")"
fi

# Parse the compact line into a package meta blob, then send the index path as
# the snippet. compactRef renders this as a "read the index first" reference.
index="" items="" w="" h=""
IFS='|' read -ra parts <<<"${out#grab:}"
for kv in "${parts[@]}"; do
  case "$kv" in
    index=*) index="${kv#index=}" ;;
    items=*) items="${kv#items=}" ;;
    w=*)     w="${kv#w=}" ;;
    h=*)     h="${kv#h=}" ;;
  esac
done
[[ -n "$index" ]] || { echo "aico-grab: st ui grab produced no index ($out)" >&2; exit 1; }
meta="$(printf '{"package":true,"items":%s,"w":%s,"h":%s}' "${items:-0}" "${w:-0}" "${h:-0}")"
st selection send region --snippet "$index" --meta "$meta"
