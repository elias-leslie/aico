#!/usr/bin/env bash
# Build and install aico-hook for this user (native/hook): the binary, its data/*.json and the Pi extension under
# ~/.local/lib/aico/hook/releases/<tree id>, `current` pointing at it, and ~/.local/bin/aico-hook. It does not touch
# any tool's hook config (that is the swap: claude-config, codex-config, ~/.pi/agent/extensions). Roll back the
# binary with `ln -sfn "$(readlink ~/.local/lib/aico/hook/previous)" ~/.local/lib/aico/hook/current`.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
base=$HOME/.local/lib/aico/hook
# The committed tree id; uncommitted changes get a content hash instead.
if rel=$(git -C "$repo" rev-parse --short=12 "HEAD:native/hook" 2>/dev/null) &&
  [ -z "$(git -C "$repo" status --porcelain -- native/hook)" ]; then :; else
  rel=$(cd "$here" && git ls-files -co --exclude-standard | sort | xargs sha256sum | sha256sum | cut -c1-12)-dirty
fi
export PATH=/usr/bin:/bin:$PATH GOTOOLCHAIN=local

dest=$base/releases/$rel
if [ ! -x "$dest/aico-hook" ] || [ "${rel%-dirty}" != "$rel" ]; then
  rm -rf "$dest.tmp" && install -d "$dest.tmp/data" "$dest.tmp/pi"
  (cd "$here" && go build -trimpath -o "$dest.tmp/aico-hook" .)
  install -m 0644 "$here"/data/*.json "$dest.tmp/data/"
  install -m 0644 "$here/pi/aico-hook.ts" "$dest.tmp/pi/"
  rm -rf "$dest" && mv -T "$dest.tmp" "$dest"
fi
prev=$(readlink "$base/current" 2>/dev/null || true)
ln -sfn "releases/$rel" "$base/current.tmp" && mv -T "$base/current.tmp" "$base/current"
[ -z "$prev" ] || [ "$prev" = "releases/$rel" ] || ln -sfn "$prev" "$base/previous"
prev=$(readlink "$base/previous" 2>/dev/null || true)
for d in "$base"/releases/*/; do # keep this release and the one before it
  name=$(basename "$d")
  [ "releases/$name" = "releases/$rel" ] || [ "releases/$name" = "$prev" ] || rm -rf "$d"
done
install -d "$HOME/.local/bin"
ln -sfn "$base/current/aico-hook" "$HOME/.local/bin/aico-hook.tmp" && mv -T "$HOME/.local/bin/aico-hook.tmp" "$HOME/.local/bin/aico-hook"
echo "aico-hook $rel installed: $HOME/.local/bin/aico-hook -> $base/current/aico-hook"
