#!/usr/bin/env bash
# Install an already built release (dist/tether.mjs, bin/tether and the
# `st aico` client) into the stable path ~/.local/lib/tether, without building.
# SummitFlow's rendered tether@default.service runs it as ExecStartPre, so
# `st service rebuild tether` puts the release it built live on restart.
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
lib_dir="${TETHER_LIB_DIR:-$HOME/.local/lib/tether}"

install_copy() {
  local source="$1" target="$2" mode="$3"
  [ -f "$source" ] || {
    echo "tether install-release: missing $source" >&2
    exit 1
  }
  if [ -f "$target" ] && cmp -s "$source" "$target"; then
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  local tmp
  tmp="$(mktemp "$target.XXXXXX")"
  cp "$source" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$target"
  echo "installed $target from $repo"
}

install_copy "$repo/dist/tether.mjs" "$lib_dir/dist/tether.mjs" 0644
install_copy "$repo/bin/tether" "$lib_dir/bin/tether" 0755
install_copy "$repo/scripts/aico-root-watch.py" "$lib_dir/scripts/aico-root-watch.py" 0755
