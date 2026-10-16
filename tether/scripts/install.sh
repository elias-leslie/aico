#!/usr/bin/env bash
# Idempotent Tether installer.
#
#   scripts/install.sh                 build, install files and the unit template
#   scripts/install.sh --start default ...then enable and (re)start tether@default
#   scripts/install.sh --start dev     ...then (re)start tether@dev for this boot only
#   scripts/install.sh --check         only verify host prerequisites
#
# Installs:
#   ~/.local/lib/tether/{bin/tether,dist/tether.mjs}   stable start path
#   ~/.local/bin/tether -> ~/.local/lib/tether/bin/tether
#   ~/.config/systemd/user/tether@.service
#   ~/.local/lib/tether/scripts/aico-root-watch.py   the `st aico` client
#
# It never enables or starts an instance unless --start is given, and only the
# default instance is ever enabled at boot. A test instance such as tether@dev
# runs until it is stopped and does not come back after a reboot.
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
lib_dir="${TETHER_LIB_DIR:-$HOME/.local/lib/tether}"
bin_dir="${TETHER_BIN_DIR:-$HOME/.local/bin}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
start_instance=""
check_only=0

while [ $# -gt 0 ]; do
  case "$1" in
    --start)
      start_instance="${2:?--start needs an instance name}"
      shift 2
      ;;
    --check)
      check_only=1
      shift
      ;;
    -h | --help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

fail() {
  echo "tether install: $*" >&2
  exit 1
}

check_prerequisites() {
  local linger version
  linger="$(loginctl show-user "$(id -u)" --property=Linger --value 2>/dev/null || true)"
  if [ "$linger" != yes ]; then
    echo "Enabling user linger so durable sessions survive logout..."
    loginctl enable-linger "$USER" 2>/dev/null || true
    linger="$(loginctl show-user "$(id -u)" --property=Linger --value 2>/dev/null || true)"
    [ "$linger" = yes ] || fail "user linger is disabled; run: sudo loginctl enable-linger $USER"
  fi
  version="$(systemctl --version | sed -n '1s/^systemd \([0-9]*\).*/\1/p')"
  [ -n "$version" ] && [ "$version" -ge 254 ] || fail "systemd >= 254 required (found ${version:-none})"
  [ -f /sys/fs/cgroup/cgroup.controllers ] || fail "cgroup v2 (unified hierarchy) required"
  [ -x /usr/bin/tmux ] || fail "/usr/bin/tmux not found"
  echo "Prerequisites: linger=yes systemd=$version cgroup=v2 tmux=$(/usr/bin/tmux -V)"
}

# Copy only when content differs; report what changed.
install_file() {
  local source="$1" target="$2" mode="$3"
  if [ -f "$target" ] && cmp -s "$source" "$target"; then
    return 1
  fi
  mkdir -p "$(dirname "$target")"
  local tmp
  tmp="$(mktemp "$target.XXXXXX")"
  cp "$source" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$target"
  echo "installed $target"
  return 0
}

check_prerequisites
[ "$check_only" = 1 ] && exit 0

if [ ! -d "$repo/node_modules" ]; then
  (cd "$repo" && npm ci --no-audit --no-fund)
fi
(cd "$repo" && npm run --silent build)

changed=0
install_file "$repo/dist/tether.mjs" "$lib_dir/dist/tether.mjs" 0644 && changed=1 || true
install_file "$repo/bin/tether" "$lib_dir/bin/tether" 0755 && changed=1 || true
install_file "$repo/scripts/aico-root-watch.py" "$lib_dir/scripts/aico-root-watch.py" 0755 || true

mkdir -p "$bin_dir"
if [ "$(readlink "$bin_dir/tether" 2>/dev/null || true)" != "$lib_dir/bin/tether" ]; then
  if [ -e "$bin_dir/tether" ] && [ ! -L "$bin_dir/tether" ]; then
    fail "$bin_dir/tether exists and is not a symlink; move it aside"
  fi
  ln -sfn "$lib_dir/bin/tether" "$bin_dir/tether"
  echo "linked $bin_dir/tether"
fi

reload=0
install_file "$repo/systemd/tether@.service" "$unit_dir/tether@.service" 0644 && reload=1 || true

# Pane memory policy (OOMPolicy=continue and the per-pane cap) belongs to
# Nightshift's deploy/systemd/install.sh; tether doctor checks live panes.
[ "$reload" = 1 ] && systemctl --user daemon-reload

if [ -n "$start_instance" ]; then
  [[ "$start_instance" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || fail "invalid instance name: $start_instance"
  if [ "$start_instance" = default ]; then
    systemctl --user enable "tether@$start_instance.service"
  elif systemctl --user is-enabled --quiet "tether@$start_instance.service" 2>/dev/null; then
    echo "note: tether@$start_instance is enabled at boot; only tether@default should be." >&2
    echo "      systemctl --user disable tether@$start_instance.service" >&2
  fi
  if [ "$changed" = 1 ] || ! systemctl --user is-active --quiet "tether@$start_instance.service"; then
    systemctl --user restart "tether@$start_instance.service"
  fi
  systemctl --user is-active --quiet "tether@$start_instance.service" ||
    fail "tether@$start_instance failed to start; see journalctl --user -u tether@$start_instance"
  if [ "$start_instance" = default ]; then
    echo "tether@$start_instance is active"
  else
    echo "tether@$start_instance is active (not enabled at boot; stop it with: systemctl --user stop tether@$start_instance)"
  fi
fi

echo "Tether installed. Instances are not started unless --start is given."
