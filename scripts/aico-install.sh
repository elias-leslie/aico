#!/usr/bin/env bash
# Source install/update for the single-user desktop app.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# The checkout path is substituted into systemd units, the desktop entry and the
# AppArmor profile. systemd treats whitespace, quotes, backslashes and `%`
# specially, and AppArmor treats `*?[]{}` as globs, so refuse paths that cannot
# be rendered literally rather than install a broken unit or a widened profile.
case "$REPO" in
  *[[:space:]%\\\"\']* | *[*?{}]* | *'['* | *']'*)
    echo "Aico: the checkout path '$REPO' contains whitespace, quotes, a backslash, '%' or a glob character (*?[]{})." >&2
    echo "Move the checkout to a plain path and rerun the installer." >&2
    exit 1
    ;;
esac

# Privileged steps never reuse cached sudo credentials silently. They run only
# with AICO_INSTALL_PRIVILEGED=1 or after an explicit interactive yes; otherwise
# the exact commands are printed for the operator to run.
confirm_privileged() { # description -> 0 when the operator opted in
  local description="$1"
  command -v sudo >/dev/null 2>&1 || return 1
  if [ "${AICO_INSTALL_PRIVILEGED:-0}" = "1" ]; then
    echo "$description (AICO_INSTALL_PRIVILEGED=1; sudo may prompt)"
    return 0
  fi
  if [ -t 0 ] && [ -t 1 ]; then
    local answer=""
    read -r -p "$description Run these commands with sudo now? [y/N] " answer || true
    case "$answer" in y | Y | yes | YES) return 0 ;; esac
  fi
  return 1
}

# Escape the sed replacement metacharacters (backslash, &, and the # delimiter)
# so the checkout path is substituted literally.
sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'
}

require_user_manager() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "Aico requires a systemd user manager (systemctl) for aico-shell.service." >&2
    exit 1
  fi
}

# Tether owns every session (tmux servers, agent launch, End, roots); Aico is a
# view client of its API. Require an installed CLI whose daemon speaks API v1+.
# `tether --json version` prints one JSON object (older builds: a banner line first).
# TETHER_REPO only shapes the hint below; default: a sibling checkout of this one.
TETHER_REPO="${TETHER_REPO:-$(dirname "$REPO")/tether}"
tether_instructions() {
  cat >&2 <<MESSAGE
Install and start Tether first:
  cd $TETHER_REPO && scripts/install.sh --start default
Then rerun scripts/aico-install.sh. Aico talks to \$TETHER_SOCKET, or the
instance's socket at \$XDG_RUNTIME_DIR/tether/\${TETHER_INSTANCE:-default}/control.sock.
MESSAGE
}

require_tether() {
  if ! command -v tether >/dev/null 2>&1; then
    echo "Aico requires Tether, and 'tether' is not on PATH." >&2
    tether_instructions
    exit 1
  fi
  local output api
  output="$(tether --json version 2>&1 || true)"
  api="$(printf '%s\n' "$output" | sed -n '/^{/,$p' | python3 -c 'import json, sys
try:
    print(int(json.load(sys.stdin).get("apiVersion", 0)))
except Exception:
    print(0)' 2>/dev/null || echo 0)"
  if [ "$api" -ge 1 ] 2>/dev/null; then
    echo "Tether: daemon reachable, API v$api."
    return 0
  fi
  if printf '%s' "$output" | grep -q 'not reachable'; then
    echo "Aico: the Tether CLI is installed but its daemon is not running." >&2
  else
    echo "Aico: Tether did not report a compatible API version (need apiVersion >= 1):" >&2
    printf '%s\n' "$output" >&2
  fi
  tether_instructions
  exit 1
}

require_user_manager
require_tether

npm ci
# Some clean hosts have npm configured to skip lifecycle scripts. Make the
# runtime native package explicit, then verify Electron's downloaded binary
# exists; if the upstream installer leaves only package files behind, fetch the
# zip with @electron/get and extract it with Python's zipfile.
npm rebuild electron node-pty

ensure_electron_binary() {
  local electron_dir="node_modules/electron"
  local platform_path="electron"
  case "$(node -p 'process.platform')" in
    win32) platform_path="electron.exe" ;;
    darwin) platform_path="Electron.app/Contents/MacOS/Electron" ;;
  esac

  if [ -f "$electron_dir/path.txt" ] && [ -e "$electron_dir/dist/$platform_path" ]; then
    return 0
  fi

  echo "Electron: fetching runtime binary..."
  local info zip_path
  info="$(
    node <<'NODE'
const { downloadArtifact } = require('@electron/get')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const electronDir = path.join(process.cwd(), 'node_modules', 'electron')
const version = require(path.join(electronDir, 'package.json')).version
const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform
const arch = process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch

downloadArtifact({
  version,
  artifactName: 'electron',
  platform,
  arch,
  checksums: require(path.join(electronDir, 'checksums.json')),
  cacheRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'aico-electron-cache-')),
})
  .then((zip) => console.log(JSON.stringify({ zip })))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
NODE
  )"
  zip_path="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["zip"])' <<<"$info")"
  python3 - "$zip_path" "$electron_dir/dist" <<'PY'
import shutil
import sys
import zipfile
from pathlib import Path

zip_path = Path(sys.argv[1])
dist = Path(sys.argv[2])
shutil.rmtree(dist, ignore_errors=True)
dist.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(zip_path) as archive:
    archive.extractall(dist)
PY
  printf '%s' "$platform_path" >"$electron_dir/path.txt"
  chmod +x "$electron_dir/dist/$platform_path" 2>/dev/null || true
  test -e "$electron_dir/dist/$platform_path"
}

ensure_electron_binary

configure_electron_suid_sandbox() {
  [ "$(node -p 'process.platform')" = "linux" ] || return 0
  local sandbox="$REPO/node_modules/electron/dist/chrome-sandbox"
  [ -e "$sandbox" ] || return 0
  if [ "$(stat -c '%u:%a' "$sandbox" 2>/dev/null || true)" = "0:4755" ]; then
    return 0
  fi
  echo "Electron: the chrome-sandbox helper needs root ownership and the setuid bit:"
  echo "  sudo chown root:root $sandbox"
  echo "  sudo chmod 4755 $sandbox"
  if confirm_privileged "Electron: configuring chrome-sandbox."; then
    if sudo chown root:root "$sandbox" && sudo chmod 4755 "$sandbox"; then
      echo "Electron: chrome-sandbox configured."
    else
      echo "Electron: chrome-sandbox configuration failed; run the commands above manually."
    fi
  else
    echo "Electron: skipped. Run the commands above, or rerun with AICO_INSTALL_PRIVILEGED=1."
  fi
}

configure_electron_suid_sandbox
uv sync --frozen --python 3.13 --extra dev

mkdir -p "$HOME/.local/share/applications"
sed "s#__PROJECT_ROOT__#$(sed_replacement "$REPO")#g" scripts/aico.desktop >"$HOME/.local/share/applications/aico.desktop"

# Render the managed user unit exactly as `st service rebuild aico` does
# (substitute __PROJECT_ROOT__, write to the user unit directory, reload the
# user manager). It is rewritten only when its content changed. It is
# not enabled or started here: scripts/aico-launch.sh starts aico-shell.service.
install_user_unit() {
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local unit=aico-shell.service replacement rendered
  replacement="$(sed_replacement "$REPO")"
  mkdir -p "$unit_dir"
  rendered="$(sed "s#__PROJECT_ROOT__#${replacement}#g" "scripts/systemd/$unit")"
  if [ -f "$unit_dir/$unit" ] && [ "$(cat "$unit_dir/$unit")" = "$rendered" ]; then
    echo "systemd: $unit is up to date."
  else
    printf '%s\n' "$rendered" >"$unit_dir/$unit.tmp"
    mv -f "$unit_dir/$unit.tmp" "$unit_dir/$unit"
    echo "systemd: installed $unit_dir/$unit"
    if ! systemctl --user daemon-reload; then
      # No user bus (e.g. a non-login shell): the file is in place and the user
      # manager picks it up on its next reload or login.
      echo "systemd: could not reach the user manager; run 'systemctl --user daemon-reload' later." >&2
    fi
  fi
  # The pre-Tether lifecycle owner is retired. It is never stopped here: that is
  # a cutover step (docs/cutover-aico.md), done once Tether serves the sessions.
  if [ -f "$unit_dir/aico-owner.service" ]; then
    echo "systemd: aico-owner.service is retired (Tether owns sessions). After the cutover:"
    echo "  systemctl --user disable --now aico-owner.service && rm $unit_dir/aico-owner.service"
  fi
}

install_user_unit

# Electron runs with the OS sandbox enabled (webPreferences.sandbox: true). On
# kernels with kernel.apparmor_restrict_unprivileged_userns=1 (Ubuntu 24.04+)
# the sandbox cannot create its user namespace unless this checkout's Electron
# binary is granted `userns` by an AppArmor profile. The profile below is the
# minimal form Ubuntu documents for such applications. Its name is derived from
# a hash of the binary path, so separate checkouts never overwrite each other.
# Nothing is installed when the kernel restriction is off. Never aborts.
install_apparmor() {
  local restrict_file=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
  if [ "$(cat "$restrict_file" 2>/dev/null || true)" != "1" ]; then
    echo "AppArmor: unprivileged user namespaces are not restricted; no profile needed."
    return 0
  fi
  command -v apparmor_parser >/dev/null 2>&1 || return 0
  local electron_bin="$REPO/node_modules/electron/dist/electron"
  [ -x "$electron_bin" ] || return 0
  local name profile target
  name="aico-electron-$(printf '%s' "$electron_bin" | sha256sum | cut -c1-12)"
  target="/etc/apparmor.d/$name"
  profile="$(mktemp)"
  cat >"$profile" <<PROFILE
# Grants unprivileged user-namespace creation so Electron's sandbox initializes
# on kernels with apparmor_restrict_unprivileged_userns=1. Path-matched to one
# checkout's Electron binary; generated by scripts/aico-install.sh.
abi <abi/4.0>,
include <tunables/global>

profile $name $electron_bin flags=(unconfined) {
  userns,
  include if exists <local/$name>
}
PROFILE
  # Older installers wrote a fixed-name profile. Two profiles attached to the
  # same binary conflict, and the kernel then applies neither, so replace it.
  local legacy=/etc/apparmor.d/aico-electron legacy_steps=""
  if [ -f "$legacy" ] && grep -Fq "profile aico-electron $electron_bin " "$legacy"; then
    legacy_steps="  sudo apparmor_parser -R $legacy; sudo rm $legacy"
  fi
  if [ -z "$legacy_steps" ] && [ -f "$target" ] && cmp -s "$profile" "$target"; then
    echo "AppArmor: $target is already installed."
    rm -f "$profile"
    return 0
  fi
  cat <<MESSAGE
AppArmor: this kernel restricts unprivileged user namespaces, so Electron's
sandbox needs a profile that allows 'userns' for:
  $electron_bin
That binary lives in your user-writable checkout: anything that replaces the
file also receives the permission. The generated profile is $profile.
Install it with:
${legacy_steps:+$legacy_steps
}  sudo install -m 0644 $profile $target
  sudo apparmor_parser -r $target
Remove it later with:
  sudo apparmor_parser -R $target && sudo rm $target
MESSAGE
  if confirm_privileged "AppArmor: installing profile $name."; then
    if [ -n "$legacy_steps" ] &&
      ! { sudo apparmor_parser -R "$legacy" 2>/dev/null; sudo rm "$legacy"; }; then
      echo "AppArmor: could not remove $legacy; run the commands above manually."
      return 0
    fi
    if sudo install -m 0644 "$profile" "$target" && sudo apparmor_parser -r "$target"; then
      echo "AppArmor: profile $name loaded."
      rm -f "$profile"
    else
      echo "AppArmor: install failed; run the commands above manually."
    fi
  else
    echo "AppArmor: skipped. Run the commands above, or rerun with AICO_INSTALL_PRIVILEGED=1."
  fi
}
install_apparmor || true

cat <<'EOF'
Aico source install complete.

Launch:
  scripts/aico-launch.sh

Stop:
  scripts/aico-stop.sh
EOF
