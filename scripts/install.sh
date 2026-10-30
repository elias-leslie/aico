#!/usr/bin/env bash
# Install Aico from this checkout: the desktop app, the web app and the Tether
# session daemon. For a first install or a host without SummitFlow; on a
# SummitFlow host `st service rebuild aico` deploys instead.
#
#   scripts/install.sh                 build and install; start nothing
#   scripts/install.sh --start         ...then enable and (re)start tether@default and the web app
#   scripts/install.sh --dry-run       print what would happen; change nothing
#   scripts/install.sh --skip-systemd  build and install files only (no units, no
#                                      linger/systemd checks; for clean-room runs)
#
# Installs (rerunning changes only what differs):
#   node_modules and the desktop/Tether/web builds
#   ~/.local/lib/tether (Tether's bundle, CLI and shims), ~/.local/bin/tether
#   user units from scripts/systemd/ plus tether/systemd/tether@.service and
#   tether-link@.service
#   ~/.local/share/applications/aico.desktop
#   ~/.pi/agent/extensions/st-coord.ts, only when SummitFlow is installed
#
# TETHER_LIB_DIR and TETHER_BIN_DIR move the Tether install; XDG_CONFIG_HOME
# moves the units. Launch the desktop app with scripts/aico-launch.sh.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

DRY_RUN=0
START=0
SKIP_SYSTEMD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --start) START=1 ;;
    --skip-systemd) SKIP_SYSTEMD=1 ;;
    -h | --help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "install: unknown argument: $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done
if [ "$START" = 1 ] && [ "$SKIP_SYSTEMD" = 1 ]; then
  echo "install: --start needs systemd; drop --skip-systemd" >&2
  exit 2
fi

LIB_DIR="${TETHER_LIB_DIR:-$HOME/.local/lib/tether}"
BIN_DIR="${TETHER_BIN_DIR:-$HOME/.local/bin}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
APPS_DIR="$HOME/.local/share/applications"
PI_COORD_SOURCE="${ST_PI_COORD_EXTENSION:-$HOME/.summitflow/services/projects/summitflow/current/source/scripts/lib/pi-coord-extension.ts}"
PI_COORD_LINK="$HOME/.pi/agent/extensions/st-coord.ts"
# Started by --start. aico-shell.service is the desktop app's unit:
# scripts/aico-launch.sh starts it.
START_UNITS=(tether@default.service aico-web.service)

fail() {
  echo "install: $*" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$1"
}

# Run a command, or print it under --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf 'would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# The checkout path is substituted into systemd units, the desktop entry and the
# AppArmor profile. systemd treats whitespace, quotes, backslashes and `%`
# specially, and AppArmor treats `*?[]{}` as globs, so refuse paths that cannot
# be rendered literally rather than install a broken unit or a widened profile.
case "$REPO" in
  *[[:space:]%\\\"\']* | *[*?{}]* | *'['* | *']'*)
    fail "the checkout path '$REPO' contains whitespace, quotes, a backslash, '%' or a glob character (*?[]{}); move it to a plain path"
    ;;
esac

# Escape the sed replacement metacharacters (backslash, &, and the # delimiter)
# so the checkout path is substituted literally.
sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'
}

# Write content to target when it differs; returns 1 when it was already current.
install_content() { # content target mode
  local content="$1" target="$2" mode="$3" tmp
  if [ -f "$target" ] && [ "$(cat "$target")" = "$content" ]; then
    return 1
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "would write $target"
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  tmp="$(mktemp "$target.XXXXXX")"
  printf '%s\n' "$content" >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$target"
  echo "installed $target"
}

render() { # template -> its text with __PROJECT_ROOT__ set to this checkout
  sed "s#__PROJECT_ROOT__#$(sed_replacement "$REPO")#g" "$1"
}

# Point link at source unless it already does; refuse to replace a real file.
install_link() { # source link
  local source="$1" link="$2"
  [ "$(readlink "$link" 2>/dev/null || true)" = "$source" ] && return 0
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    fail "$link exists and is not a symlink; move it aside"
  fi
  run mkdir -p "$(dirname "$link")"
  run ln -sfn "$source" "$link"
  [ "$DRY_RUN" = 1 ] || echo "linked $link"
}

check_prerequisites() {
  local missing=() command major
  for command in node npm python3 git; do
    command -v "$command" >/dev/null 2>&1 || missing+=("$command")
  done
  [ ${#missing[@]} -eq 0 ] || fail "missing: ${missing[*]} (Node.js 22+ with npm, Python 3, git)"
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || fail "Node.js 22+ required (found $(node --version))"
  [ "$SKIP_SYSTEMD" = 1 ] && return 0

  # Tether needs a user manager that outlives logout, cgroup v2 and tmux.
  local linger version
  command -v systemctl >/dev/null 2>&1 || fail "a systemd user manager (systemctl) is required"
  version="$(systemctl --version | sed -n '1s/^systemd \([0-9]*\).*/\1/p')"
  [ -n "$version" ] && [ "$version" -ge 254 ] || fail "systemd >= 254 required (found ${version:-none})"
  [ -f /sys/fs/cgroup/cgroup.controllers ] || fail "cgroup v2 (unified hierarchy) required"
  [ -x /usr/bin/tmux ] || fail "/usr/bin/tmux not found; install tmux"
  linger="$(loginctl show-user "$(id -u)" --property=Linger --value 2>/dev/null || true)"
  if [ "$linger" != yes ]; then
    echo "Enabling user linger so sessions survive logout..."
    run loginctl enable-linger "$USER" || true
    if [ "$DRY_RUN" = 0 ]; then
      linger="$(loginctl show-user "$(id -u)" --property=Linger --value 2>/dev/null || true)"
      [ "$linger" = yes ] || fail "user linger is off; run: sudo loginctl enable-linger $USER"
    fi
  fi
  echo "Prerequisites: node $(node --version), systemd $version, cgroup v2, $(/usr/bin/tmux -V)"
}

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


# Electron's sandbox needs unprivileged user namespaces. Prints "open" when
# they work, "apparmor" when AppArmor restricts them (the profile below fixes
# that), or "off" when the kernel turns them off (only the setuid helper helps).
userns_state() {
  if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = "0" ] ||
    [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)" = "0" ]; then
    echo off
  elif [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true)" = "1" ]; then
    echo apparmor
  else
    echo open
  fi
}

# The setuid chrome-sandbox helper is the fallback for when user namespaces
# are unavailable: offered only when the kernel restricts them and no AppArmor
# profile for this checkout's Electron is installed (install_apparmor sets
# APPARMOR_PROFILE_READY). Otherwise the helper stays as npm left it.
configure_electron_suid_sandbox() {
  [ "$(node -p 'process.platform')" = "linux" ] || return 0
  local sandbox="$REPO/node_modules/electron/dist/chrome-sandbox"
  [ -e "$sandbox" ] || return 0
  if [ "$(stat -c '%u:%a' "$sandbox" 2>/dev/null || true)" = "0:4755" ]; then
    return 0
  fi
  case "$(userns_state)" in
    open)
      echo "Electron: user namespaces are available; chrome-sandbox needs no setuid bit."
      return 0
      ;;
    apparmor)
      if [ "${APPARMOR_PROFILE_READY:-0}" = "1" ]; then
        echo "Electron: the AppArmor profile allows user namespaces; chrome-sandbox needs no setuid bit."
        return 0
      fi
      echo "Electron: this kernel restricts user namespaces and no AppArmor profile for Electron is installed,"
      ;;
    off)
      echo "Electron: this kernel turns off unprivileged user namespaces,"
      ;;
  esac
  echo "so the chrome-sandbox helper needs root ownership and the setuid bit:"
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

# Electron runs with the OS sandbox enabled (webPreferences.sandbox: true). On
# kernels with kernel.apparmor_restrict_unprivileged_userns=1 (Ubuntu 24.04+)
# the sandbox cannot create its user namespace unless this checkout's Electron
# binary is granted `userns` by an AppArmor profile. The profile below is the
# minimal form Ubuntu documents for such applications. Its name is derived from
# a hash of the binary path, so separate checkouts never overwrite each other.
# Nothing is installed when the kernel restriction is off. Never aborts. Sets
# APPARMOR_PROFILE_READY=1 when this checkout's profile is installed.
APPARMOR_PROFILE_READY=0
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
# checkout's Electron binary; generated by scripts/install.sh.
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
    APPARMOR_PROFILE_READY=1
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
      APPARMOR_PROFILE_READY=1
      rm -f "$profile"
    else
      echo "AppArmor: install failed; run the commands above manually."
    fi
  else
    echo "AppArmor: skipped. Run the commands above, or rerun with AICO_INSTALL_PRIVILEGED=1."
  fi
}

install_units() {
  local unit changed=0
  for unit in scripts/systemd/*.service; do
    install_content "$(render "$unit")" "$UNIT_DIR/$(basename "$unit")" 0644 && changed=1
  done
  # The generic template, for test instances such as tether@dev.
  install_content "$(cat tether/systemd/tether@.service)" "$UNIT_DIR/tether@.service" 0644 && changed=1
  # One ssh link per remote host in ~/.config/tether/hosts.json (enabled per host).
  install_content "$(cat tether/systemd/tether-link@.service)" "$UNIT_DIR/tether-link@.service" 0644 && changed=1
  if [ "$changed" = 1 ]; then
    run systemctl --user daemon-reload ||
      echo "systemd: could not reach the user manager; run 'systemctl --user daemon-reload' later." >&2
  else
    echo "systemd: units are up to date."
  fi
}

check_prerequisites

step "Node dependencies and builds"
run npm ci --no-audit --no-fund
# Some hosts configure npm to skip lifecycle scripts: make Electron's runtime
# explicit, then make sure its binary really exists.
run npm rebuild electron
if [ "$DRY_RUN" = 1 ]; then
  echo "would check node_modules/electron/dist and fetch Electron's binary if it is missing"
else
  ensure_electron_binary
fi
run npm run build

step "Tether"
[ "$DRY_RUN" = 1 ] || [ -f tether/dist/tether.mjs ] || fail "tether/dist/tether.mjs is missing after the build"
run env TETHER_LIB_DIR="$LIB_DIR" tether/scripts/install-release.sh
install_link "$LIB_DIR/bin/tether" "$BIN_DIR/tether"

step "Desktop entry"
install_content "$(render scripts/aico.desktop)" "$APPS_DIR/aico.desktop" 0644 || echo "aico.desktop is up to date."

if [ -e "$PI_COORD_SOURCE" ]; then
  step "Pi coordination extension"
  install_link "$PI_COORD_SOURCE" "$PI_COORD_LINK"
fi

if [ "$SKIP_SYSTEMD" = 0 ]; then
  step "User units"
  install_units
fi

if [ "$DRY_RUN" = 1 ]; then
  step "Electron sandbox"
  echo "would check user namespaces and offer an AppArmor profile or the setuid chrome-sandbox helper if needed"
else
  step "Electron sandbox"
  install_apparmor || true
  configure_electron_suid_sandbox
fi

if [ "$START" = 1 ]; then
  step "Starting"
  run systemctl --user enable "${START_UNITS[@]}"
  run systemctl --user restart "${START_UNITS[@]}"
  if [ "$DRY_RUN" = 0 ]; then
    for unit in "${START_UNITS[@]}"; do
      systemctl --user is-active --quiet "$unit" || fail "$unit failed to start; see journalctl --user -u $unit"
    done
    echo "Started: ${START_UNITS[*]}"
  fi
fi

[ "$DRY_RUN" = 1 ] && echo && echo "Dry run: nothing was changed." && exit 0
cat <<EOF

Aico is installed.
  Start Tether and the web app: scripts/install.sh --start
    (or systemctl --user enable --now ${START_UNITS[*]})
  Desktop app:                  scripts/aico-launch.sh
  Web app:                      http://localhost:3002
EOF
