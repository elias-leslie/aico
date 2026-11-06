#!/usr/bin/env bash
# Installs host-steward as root services and timers (run as root; the caller runs `aico declare` for the change
# first). Copies the package to $HS_PREFIX (default /usr/local/lib/host-steward) with the Status helper beside it,
# links the launcher into $HS_BIN, installs the units into $HS_UNIT_DIR and the sudoers line into $HS_SUDOERS_DIR,
# and enables the timers: the check pass, the usage collector, housekeeping and the space guard (dry runs until
# [acting] is switched on in checks.toml), plus the zswap, input-watch and home-off services. The scrub and NVMe
# self-test timers follow [acting] scrub / nvme_tests: enabled while on, disabled while off, and their Status rows
# are reposted at once (--status starts nothing). The memory controller and the display guard are user units of
# $HS_OWNER (installed to $HS_USER_UNIT_DIR, enabled; memctl acts per [acting] memctl). The split-horizon DNS
# (dnsmasq on 127.0.0.1, config in $HS_ETC_DIR/split-dns.conf) is installed and started with them.
# host-config/ holds the host settings (sysctl, oomd, journald, systemd memory drop-ins, apt, udev, tmpfiles);
# its manifest.tsv names where each file goes and which older file it replaces. The old Nightshift-named files and
# units are copied into $HS_STATE_DIR/archive/nightshift-retired/ (same relative path) and then removed.
# HS_NO_SYSTEMCTL=1 copies files only (tests); HS_CONF_ROOT and HS_OWNER_HOME redirect /etc and the owner's home.
set -euo pipefail
if [ "${HS_NO_SYSTEMCTL:-0}" != 1 ] && [ "${HS_SIGNATURE_VERIFIED:-0}" != 1 ]; then
  echo 'Use install-signed.py with a signed update archive.' >&2
  exit 1
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix="${HS_PREFIX:-/usr/local/lib/host-steward}"
bin_dir="${HS_BIN:-/usr/local/bin}"
unit_dir="${HS_UNIT_DIR:-/etc/systemd/system}"
user_unit_dir="${HS_USER_UNIT_DIR:-/etc/systemd/user}"
sudoers_dir="${HS_SUDOERS_DIR:-/etc/sudoers.d}"
owner="${HS_OWNER:-kasadis}"
etc_dir="${HS_ETC_DIR:-/etc/aico}"
state_dir="${HS_STATE_DIR:-/var/lib/host-steward}"
conf_root="${HS_CONF_ROOT:-}"
owner_home="${HS_OWNER_HOME:-$(getent passwd "$owner" | cut -d: -f6 || true)}"
owner_uid="$(id -u "$owner" 2>/dev/null || echo 1000)"
enable_timers=(host-steward-grants.service host-steward-rules.timer host-steward-heartbeat.timer host-steward-fcm-token.timer host-steward-check.timer host-steward-collect-usage.timer host-steward-housekeeping.timer host-steward-space-guard.timer aico-split-dns.service host-steward-zswap.service host-steward-input-watch.service host-steward-home-off.service)
user_units=(host-steward-memctl.service host-steward-display-guard.service)
archive="$state_dir/archive/nightshift-retired"
real=1
[ "${HS_NO_SYSTEMCTL:-0}" != 1 ] || real=0

# Copies a file that is about to go into the archive (same path below it), then removes it.
retire_file() {
  local file=$1 rel=${1#"$conf_root"}
  [ -e "$file" ] || return 0
  install -D -m 0600 "$file" "$archive/${rel#/}"
  rm -f "$file"
  # A drop-in directory in the owner's home that this emptied goes too.
  [ -n "$owner_home" ] || return 0
  case $file in "$owner_home"/*.d/*) rmdir --ignore-fail-on-non-empty "$(dirname "$file")" ;; esac
}

# Fills the @TOKEN@ placeholders of a manifest path.
expand() {
  local path=$1
  path=${path//@ETC@/$conf_root/etc}
  path=${path//@SYSTEM@/$unit_dir}
  path=${path//@USER@/$user_unit_dir}
  path=${path//@HOME@/$owner_home}
  path=${path//@UID@/$owner_uid}
  printf '%s' "$path"
}

# Runs systemctl --user as the owner's user manager.
owner_systemctl() {
  runuser -u "$owner" -- env "XDG_RUNTIME_DIR=/run/user/$owner_uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$owner_uid/bus" \
    systemctl --user "$@"
}

# The host settings from host-config/: install each file, then remove the older file(s) it replaces.
install_host_config() {
  local src dest old file
  while IFS=$'\t' read -r src dest old; do
    case $src in '' | '#'*) continue ;; esac
    dest=$(expand "$dest")
    install -d -m 0755 "$(dirname "$dest")"
    sed "s/@OWNER@/$owner/g" "$here/host-config/$src" >"$dest.new"
    chmod 0644 "$dest.new"
    mv -f "$dest.new" "$dest"
    for file in $old; do
      [ -n "$owner_home" ] || case $file in @HOME@*) continue ;; esac
      retire_file "$(expand "$file")"
    done
  done <"$here/host-config/manifest.tsv"
}

# Nightshift's units that host-steward replaced: stopped and disabled, then their files archived and removed.
retire_nightshift_units() {
  local unit file
  for unit in nightshift-zswap.service nightshift-input-watch.service nightshift-boot-mark.service 'run-nightshift\x2dsigning.mount'; do
    file="$unit_dir/$unit"
    [ -e "$file" ] || continue
    if [ "$real" = 1 ]; then
      if [ "$unit" = nightshift-boot-mark.service ]; then
        # Its stop would tell the PVE host and the phone app this host is off on purpose; the host is not.
        install -d "$file.d"
        printf '[Service]\nExecStop=\n' >"$file.d/10-no-stop.conf"
        systemctl --no-ask-password daemon-reload
      fi
      systemctl --no-ask-password disable --now "$unit"
    fi
    retire_file "$file"
    rm -rf "$file.d"
  done
  local user_dir="$owner_home/.config/systemd/user"
  [ -n "$owner_home" ] || return 0
  for unit in nightshift-display-guard.service nightshift-postboot.timer nightshift-postboot.service; do
    file="$user_dir/$unit"
    [ -e "$file" ] || continue
    if [ "$real" = 1 ]; then
      case $unit in nightshift-postboot.service) ;; *) owner_systemctl disable --now "$unit" ;; esac
    fi
    retire_file "$file"
  done
}

if [ "$real" = 1 ]; then
  # Keys, site data and phone-sender files move to their new homes before the new checks.toml points there.
  python3 - "$here" <<'MIGRATE'
import sys
sys.path.insert(0, sys.argv[1])
from host_steward.installer import migrate
migrate()
MIGRATE
fi

install -d -m 0755 "$prefix" "$bin_dir" "$unit_dir" "$user_unit_dir" "$etc_dir"
rm -rf "$prefix/host_steward"
mkdir -p "$prefix/host_steward"
(cd "$here/host_steward" && find . -type f \( -name '*.py' -o -name '*.toml' -o -name '*.json' \) -not -path '*/__pycache__/*' \
  -exec install -D -m 0644 {} "$prefix/host_steward/{}" \;)
install -m 0644 "$here/aico_status.py" "$prefix/aico_status.py"
install -m 0755 "$here/host-steward" "$prefix/host-steward"
install -m 0755 "$here/aico-grants" "$prefix/aico-grants"
install -m 0755 "$here/install-signed.py" "$prefix/install-signed.py"
ln -sfn "$prefix/host-steward" "$bin_dir/host-steward"
cmp -s "$here/dnsmasq/aico-split-dns.conf" "$etc_dir/split-dns.conf" && dns_same=1 || dns_same=0
install -m 0644 "$here/dnsmasq/aico-split-dns.conf" "$etc_dir/split-dns.conf"
for unit in "$here"/systemd/*.service "$here"/systemd/*.timer; do
  case "$(basename "$unit")" in
    host-steward-memctl.service | host-steward-display-guard.service) install -m 0644 "$unit" "$user_unit_dir/" ;;
    *) install -m 0644 "$unit" "$unit_dir/" ;;
  esac
done
install_host_config
# Validate before it goes live: a bad sudoers file locks sudo.
if [ "$real" = 1 ]; then
  visudo -cf "$here/sudoers/60-host-steward" >/dev/null
fi
mkdir -p "$sudoers_dir"
# Declarations and lab-use hints are written by the owner's agent sessions (no privilege), read by the root checks.
hints="$state_dir/agent-hints"
install -d -m 0755 "$hints"
if [ "$(id -u)" = 0 ]; then chown "$owner" "$hints"; fi
install -m 0440 "$here/sudoers/60-host-steward" "$sudoers_dir/60-host-steward"
retire_nightshift_units

if [ "$real" = 1 ]; then
  systemd-tmpfiles --create "$conf_root/etc/tmpfiles.d/host-steward.conf"
  udevadm control --reload
  systemctl --no-ask-password daemon-reload
  systemctl --no-ask-password enable --now "${enable_timers[@]}"
  # A running resolver reads its config only at start; restart it just when the config changed.
  [ "$dns_same" = 1 ] || systemctl --no-ask-password try-restart aico-split-dns.service
  read -r scrub_on nvme_on < <(python3 -c 'import sys, tomllib
a = tomllib.load(open(sys.argv[1], "rb")).get("acting", {})
print(int(bool(a.get("scrub"))), int(bool(a.get("nvme_tests"))))' "$here/host_steward/data/checks.toml")
  for pair in "$scrub_on host-steward-scrub-native.timer host-steward-scrub-root.timer" \
    "$nvme_on host-steward-nvme-short-test.timer host-steward-nvme-long-test.timer"; do
    read -r on timers <<<"$pair"
    # shellcheck disable=SC2086 # two timer names
    if [ "$on" = 1 ]; then systemctl --no-ask-password enable --now $timers
    else systemctl --no-ask-password disable --now $timers; fi
  done
  for target in native root; do
    "$prefix/host-steward" scrub --target "$target" --status >/dev/null || echo "scrub $target row: exit $?"
  done
  for kind in short long; do
    "$prefix/host-steward" nvme-test "$kind" --status >/dev/null || echo "nvme-test $kind row: exit $?"
  done
  owner_systemctl daemon-reload
  owner_systemctl enable "${user_units[@]}"
  # Long-running: restart so a new install's code and paths take effect (memctl kept the old ones otherwise).
  owner_systemctl restart "${user_units[@]}"
fi
echo "host-steward installed in $prefix"
