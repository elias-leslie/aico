#!/usr/bin/env bash
set -euo pipefail

width="${1:-64}"

if ! [[ "$width" =~ ^[0-9]+$ ]] || (( width < 8 || width > 256 )); then
  echo "usage: $0 [width: 8-256]" >&2
  exit 1
fi

rgb_at() {
  local i="$1"
  local max="$2"
  local r g b
  r=$(( (255 * i) / max ))
  g=$(( (255 * (max - i)) / max ))
  if (( i <= max / 2 )); then
    b=$(( (255 * i * 2) / max ))
  else
    b=$(( (255 * (max - i) * 2) / max ))
  fi
  printf '%s;%s;%s' "$r" "$g" "$b"
}

print_truecolor_background() {
  local max=$(( width - 1 ))
  local i rgb
  for ((i = 0; i < width; i++)); do
    rgb="$(rgb_at "$i" "$max")"
    printf '\033[48;2;%sm ' "$rgb"
  done
  printf '\033[0m\n'
}

print_truecolor_foreground() {
  local max=$(( width - 1 ))
  local i rgb
  for ((i = 0; i < width; i++)); do
    rgb="$(rgb_at "$i" "$max")"
    printf '\033[38;2;%sm#' "$rgb"
  done
  printf '\033[0m\n'
}

print_256_background() {
  local i color
  for ((i = 0; i < width; i++)); do
    color=$(( 16 + (215 * i) / (width - 1) ))
    printf '\033[48;5;%sm ' "$color"
  done
  printf '\033[0m\n'
}

print_named_swatches() {
  printf '\033[48;2;255;0;0m  red  \033[0m '
  printf '\033[48;2;0;255;0m green \033[0m '
  printf '\033[48;2;0;0;255m blue  \033[0m '
  printf '\033[48;2;255;140;0morange \033[0m '
  printf '\033[48;2;180;0;255mpurple \033[0m\n'
}

cat <<EOF
Truecolor Terminal Test
TERM=${TERM:-unknown}
TMUX=${TMUX:+yes}${TMUX:-no}

What to look for:
- The two TRUECOLOR bars should look smooth, with no obvious band boundaries.
- The 256-COLOR bar should look more stepped/banded than the truecolor bars.
- The swatches should be vivid and distinct, not muddy or quantized.
EOF

printf '\nTRUECOLOR background gradient\n'
print_truecolor_background

printf '\nTRUECOLOR foreground gradient\n'
print_truecolor_foreground

printf '\n256-COLOR comparison gradient\n'
print_256_background

printf '\nNamed RGB swatches\n'
print_named_swatches

printf '\nSample explicit RGB escapes\n'
printf '\033[38;2;255;100;0mFG 255,100,0\033[0m | '
printf '\033[48;2;10;120;220mBG 10,120,220\033[0m\n'
