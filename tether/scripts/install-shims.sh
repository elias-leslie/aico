#!/usr/bin/env bash
# Sourced by install.sh and install-release.sh: install the agent shims
# (scripts/shims/) into <lib_dir>/shims and link one name per line of
# shims.list to tether-shim. Stale links to tether-shim are removed.
# Usage: install_shims <repo> <lib_dir>
install_shims() {
  local repo="$1" lib_dir="$2" dest="$2/shims" source="$1/scripts/shims" name rest link
  local -A wanted=()
  [ -f "$source/tether-shim" ] && [ -f "$source/shims.list" ] || {
    echo "tether install-shims: missing $source" >&2
    return 1
  }
  mkdir -p "$dest"
  for file in tether-shim:0755 shims.list:0644; do
    local target="$dest/${file%%:*}" tmp
    if [ -f "$target" ] && cmp -s "$source/${file%%:*}" "$target"; then continue; fi
    tmp="$(mktemp "$target.XXXXXX")"
    cp "$source/${file%%:*}" "$tmp"
    chmod "${file##*:}" "$tmp"
    mv -f "$tmp" "$target"
    echo "installed $target from $repo"
  done
  while read -r name rest || [ -n "$name" ]; do
    case "$name" in '' | '#'*) continue ;; esac
    wanted[$name]=1
    [ "$(readlink "$dest/$name" 2>/dev/null || true)" = tether-shim ] && continue
    ln -sfn tether-shim "$dest/$name"
    echo "linked $dest/$name"
  done <"$dest/shims.list"
  for link in "$dest"/*; do
    [ -L "$link" ] || continue
    name="${link##*/}"
    [ "$(readlink "$link")" = tether-shim ] && [ -z "${wanted[$name]:-}" ] && rm -f "$link" && echo "removed $link"
  done
  return 0
}
