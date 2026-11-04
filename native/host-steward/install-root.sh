#!/usr/bin/env bash
# Installs the host-steward checks as a root service and timer (run as root; the caller declares the change
# to Nightshift first). Copies the package to $HS_PREFIX (default /usr/local/lib/host-steward) with the Status
# helper beside it, links the launcher into $HS_BIN, installs the units into $HS_UNIT_DIR and enables the timer.
# HS_NO_SYSTEMCTL=1 copies files only (tests).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix="${HS_PREFIX:-/usr/local/lib/host-steward}"
bin_dir="${HS_BIN:-/usr/local/bin}"
unit_dir="${HS_UNIT_DIR:-/etc/systemd/system}"

install -d -m 0755 "$prefix" "$bin_dir" "$unit_dir"
rm -rf "$prefix/host_steward"
mkdir -p "$prefix/host_steward"
(cd "$here/host_steward" && find . -type f \( -name '*.py' -o -name '*.toml' \) -not -path '*/__pycache__/*' \
  -exec install -D -m 0644 {} "$prefix/host_steward/{}" \;)
install -m 0644 "$here/aico_status.py" "$prefix/aico_status.py"
install -m 0755 "$here/host-steward" "$prefix/host-steward"
ln -sfn "$prefix/host-steward" "$bin_dir/host-steward"
install -m 0644 "$here/systemd/host-steward-check.service" "$here/systemd/host-steward-check.timer" "$unit_dir/"

if [ "${HS_NO_SYSTEMCTL:-0}" != 1 ]; then
  systemctl --no-ask-password daemon-reload
  systemctl --no-ask-password enable --now host-steward-check.timer
fi
echo "host-steward installed in $prefix"
