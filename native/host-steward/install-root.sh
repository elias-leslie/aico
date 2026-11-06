#!/usr/bin/env bash
# Installs host-steward as root services and timers (run as root; the caller declares the change to Nightshift
# first). Copies the package to $HS_PREFIX (default /usr/local/lib/host-steward) with the Status helper beside it,
# links the launcher into $HS_BIN, installs the units into $HS_UNIT_DIR and the sudoers line into $HS_SUDOERS_DIR,
# and enables the timers that are safe beside Nightshift's: the check pass, the usage collector, and housekeeping
# and the space guard (dry runs until [acting] is switched on in checks.toml). The scrub and NVMe self-test timers
# follow [acting] scrub / nvme_tests: enabled while on, disabled while off (Nightshift's run them then), and their
# Status rows are reposted at once (--status starts nothing). The memory controller is a user unit of $HS_OWNER
# (installed to $HS_USER_UNIT_DIR, enabled; it acts per [acting] memctl). The split-horizon DNS (dnsmasq on
# 127.0.0.1, config in $HS_ETC_DIR/split-dns.conf) is installed and started with them.
# HS_NO_SYSTEMCTL=1 copies files only (tests).
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
enable_timers=(host-steward-grants.service host-steward-rules.timer host-steward-heartbeat.timer host-steward-fcm-token.timer host-steward-check.timer host-steward-collect-usage.timer host-steward-housekeeping.timer host-steward-space-guard.timer aico-split-dns.service)

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
    host-steward-memctl.service) install -m 0644 "$unit" "$user_unit_dir/" ;;
    *) install -m 0644 "$unit" "$unit_dir/" ;;
  esac
done
# Validate before it goes live: a bad sudoers file locks sudo.
if [ "${HS_NO_SYSTEMCTL:-0}" != 1 ]; then
  visudo -cf "$here/sudoers/60-host-steward" >/dev/null
fi
mkdir -p "$sudoers_dir"
# Declarations and lab-use hints are written by the owner's agent sessions (no privilege), read by the root checks.
hints="${HS_STATE_DIR:-/var/lib/host-steward}/agent-hints"
install -d -m 0755 "$hints"
if [ "$(id -u)" = 0 ]; then chown "$owner" "$hints"; fi
install -m 0440 "$here/sudoers/60-host-steward" "$sudoers_dir/60-host-steward"

if [ "${HS_NO_SYSTEMCTL:-0}" != 1 ]; then
  python3 - "$here" <<'MIGRATE'
import sys
sys.path.insert(0, sys.argv[1])
from host_steward.installer import migrate
migrate()
MIGRATE
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
  owner_uid="$(id -u "$owner")"
  user_env=(env "XDG_RUNTIME_DIR=/run/user/$owner_uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$owner_uid/bus")
  runuser -u "$owner" -- "${user_env[@]}" systemctl --user daemon-reload
  runuser -u "$owner" -- "${user_env[@]}" systemctl --user enable --now host-steward-memctl.service
fi
echo "host-steward installed in $prefix"
