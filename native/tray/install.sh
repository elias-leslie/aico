#!/usr/bin/env bash
# Build and install the Aico tray for this user (native/tray): the release binary under
# ~/.local/lib/aico/tray/releases/<tree id> with `current` pointing at it, the icons, the user unit aico-tray and
# the GNOME Shell extension files. Needs rustup in ~/.cargo/bin (rust-toolchain.toml pins the compiler) and
# libgtk-4, libfido2 on the machine. Starts nothing it did not start: pass --start to (re)start the unit.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
base=$HOME/.local/lib/aico
tray=$base/tray
rel=$(git -C "$repo" rev-parse --short=12 "HEAD:native/tray")
export PATH=$HOME/.cargo/bin:$PATH
export CARGO_TARGET_DIR=${XDG_CACHE_HOME:-$HOME/.cache}/aico-tray/target

if [ ! -x "$tray/releases/$rel/aico-tray" ]; then
  (cd "$here" && cargo build --release --locked)
  install -D -m 0755 "$CARGO_TARGET_DIR/release/aico-tray" "$tray/releases/$rel/aico-tray"
fi
prev=$(readlink "$tray/current" 2>/dev/null || true)
ln -sfn "releases/$rel" "$tray/current.tmp" && mv -T "$tray/current.tmp" "$tray/current"
[ -z "$prev" ] || ln -sfn "$prev" "$tray/previous"
# keep this release and the one before it
for d in "$tray"/releases/*/; do
  name=$(basename "$d")
  [ "$name" = "$rel" ] || [ "$name" = "$(basename "$prev")" ] || rm -rf "$d"
done

install -d "$base/icons"
icons_before=$(cat "$base"/icons/*.png 2>/dev/null | sha256sum)
install -m 0644 "$here"/icons/*.png "$base/icons/"
icons_changed=0
[ "$icons_before" = "$(cat "$base"/icons/*.png | sha256sum)" ] || icons_changed=1

install -D -m 0644 "$here/aico-tray.service" "$HOME/.config/systemd/user/aico-tray.service"
systemctl --user --no-ask-password daemon-reload

# GNOME on Wayland loads a new or changed extension only at the next login; the id stays as it was for that reason.
ext=nightshift-tray@summitflow.dev
edir=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions
install -d "$edir/$ext"
cp -f "$here"/shell-extension/$ext/* "$edir/$ext/"

if [ "${1:-}" = "--start" ]; then
  systemctl --user --no-ask-password enable aico-tray.service
  systemctl --user --no-ask-password restart aico-tray.service
fi
# The top-bar indicator extension caches tray icons by name, so a redrawn icon under the same name stays old
# until the extension reloads; the tray restarts after it so it registers again.
indicators=ubuntu-appindicators@ubuntu.com
if [ "$icons_changed" = 1 ] && gnome-extensions list --enabled 2>/dev/null | grep -qx "$indicators"; then
  gnome-extensions disable "$indicators" && gnome-extensions enable "$indicators"
  ! systemctl --user --quiet is-active aico-tray.service || systemctl --user --no-ask-password restart aico-tray.service
fi
echo "aico-tray $rel installed"
