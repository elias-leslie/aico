#!/usr/bin/env bash
# Scrollback gate helper. Run this inside an Aico widget terminal.
# It floods the pane with N (default 10000) numbered lines plus sentinels and
# a few stress lines (very long line, colored line) so you can exercise
# scroll-to-history, copy-out, and resize.

set -euo pipefail
N="${1:-10000}"

printf '\033[1;33m=== SCROLLBACK_TOP sentinel — line 1 of %s ===\033[0m\n' "$N"
echo "If you can scroll back to this line, full history is retained."
# A line wider than any sane terminal, to test wrap/reflow on resize:
printf 'LONGLINE '; for i in $(seq 1 60); do printf 'col%02d-the-quick-brown-fox ' "$i"; done; printf '\n'
# A colored line, to confirm SGR survives scrollback:
printf '\033[38;5;208mCOLORLINE amber 208 \033[38;5;39mblue 39 \033[32mgreen\033[0m\n'

for i in $(seq 1 "$N"); do
  printf 'line %05d : the quick brown fox jumps over the lazy dog 0123456789\n' "$i"
done

printf '\033[1;33m=== SCROLLBACK_BOTTOM sentinel — emitted %s lines ===\033[0m\n' "$N"
