#!/usr/bin/env bash
# Installs host-steward as root services and timers (run as root; the caller declares the change to Nightshift
# first). Copies the package to $HS_PREFIX (default /usr/local/lib/host-steward) with the Status helper beside it,
# links the launcher into $HS_BIN, installs the units into $HS_UNIT_DIR and the sudoers line into $HS_SUDOERS_DIR,
# and enables the timers that are safe beside Nightshift's: the check pass, the usage collector, and housekeeping
# and the space guard (dry runs until [acting] is switched on in checks.toml). The scrub and NVMe self-test timers
# are installed but NOT enabled (Nightshift's still run them); cutover enables them. The memory controller is a
# user unit of $HS_OWNER (installed to $HS_USER_UNIT_DIR, enabled as a dry run).
# HS_NO_SYSTEMCTL=1 copies files only (tests).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix="${HS_PREFIX:-/usr/local/lib/host-steward}"
bin_dir="${HS_BIN:-/usr/local/bin}"
unit_dir="${HS_UNIT_DIR:-/etc/systemd/system}"
user_unit_dir="${HS_USER_UNIT_DIR:-/etc/systemd/user}"
sudoers_dir="${HS_SUDOERS_DIR:-/etc/sudoers.d}"
owner="${HS_OWNER:-kasadis}"
enable_timers=(host-steward-check.timer host-steward-collect-usage.timer host-steward-housekeeping.timer host-steward-space-guard.timer)

install -d -m 0755 "$prefix" "$bin_dir" "$unit_dir" "$user_unit_dir"
rm -rf "$prefix/host_steward"
mkdir -p "$prefix/host_steward"
(cd "$here/host_steward" && find . -type f \( -name '*.py' -o -name '*.toml' \) -not -path '*/__pycache__/*' \
  -exec install -D -m 0644 {} "$prefix/host_steward/{}" \;)
install -m 0644 "$here/aico_status.py" "$prefix/aico_status.py"
install -m 0755 "$here/host-steward" "$prefix/host-steward"
ln -sfn "$prefix/host-steward" "$bin_dir/host-steward"
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
  systemctl --no-ask-password daemon-reload
  systemctl --no-ask-password enable --now "${enable_timers[@]}"
  owner_uid="$(id -u "$owner")"
  user_env=(env "XDG_RUNTIME_DIR=/run/user/$owner_uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$owner_uid/bus")
  runuser -u "$owner" -- "${user_env[@]}" systemctl --user daemon-reload
  runuser -u "$owner" -- "${user_env[@]}" systemctl --user enable --now host-steward-memctl.service
fi
echo "host-steward installed in $prefix"
