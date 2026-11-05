#!/usr/bin/env bash
# Run as root on gem, from an exported Aico native/ directory. Existing credentials stay in place.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix="${PVE_SENDER_PREFIX:-/usr/local/lib/aico-pve-sender}"
units="${PVE_SENDER_UNITS:-/etc/systemd/system}"
sbin="${PVE_SENDER_SBIN:-/usr/local/sbin}"
config="${PVE_SENDER_CONFIG:-/etc/aico/pve-sender.json}"
steward="${PVE_SENDER_STEWARD:-/usr/local/lib/host-steward}"
install -d -m 0755 "$prefix/pve_sender" "$units" "$sbin" "$steward"
install -d -m 0755 "$(dirname "$config")"
install -m 0644 "$here"/pve_sender/*.py "$prefix/pve_sender/"
install -m 0755 "$here/pve-sender" "$prefix/pve-sender"
ln -sfn "$prefix/pve-sender" "$sbin/pve-sender"
if [ ! -f "$config" ]; then install -m 0644 "$here/config.json" "$config"; fi
# These are Aico's own host-check evaluators, used locally without enabling workstation controllers on PVE.
cp -a "$here/../host-steward/host_steward" "$steward/"
install -m 0644 "$here/../host-steward/aico_status.py" "$steward/aico_status.py"
install -m 0644 "$here"/systemd/* "$units/"
if [ "${PVE_SENDER_NO_SYSTEMCTL:-0}" != 1 ]; then
  /usr/bin/python3 -c 'import cryptography' # distro dependency, present on gem
  systemctl --no-ask-password daemon-reload
  # Verify the replacement before switching either producer off. No immediate real push is forced.
  "$sbin/pve-sender" tick
  systemctl --no-ask-password enable --now aico-pve-sender.timer
  systemctl --no-ask-password enable --now aico-pve-trim.timer
  # Keep original files and old package for rollback; only the push wrapper gets a retained copy.
  if [ -f "$sbin/aico-push" ] && [ ! -f "$sbin/aico-push.pre-aico" ]; then
    cp -p "$sbin/aico-push" "$sbin/aico-push.pre-aico"
  fi
  # Preserve guest deduplication across the sender switch, using only successful old log entries.
  python3 - "$config" <<'PY'
import json
import sys
from pathlib import Path
cfg = json.loads(Path(sys.argv[1]).read_text())
target = Path(cfg["state_dir"]) / "receipts.json"
if not target.exists():
    old = Path("/var/lib/nightshift/deadman/log.json")
    entries = json.loads(old.read_text()) if old.exists() else []
    receipts = {e["key"]: e["ts"] for e in entries
                if isinstance(e, dict) and str(e.get("result", "")).startswith("sent ")
                and isinstance(e.get("ts"), (int, float)) and isinstance(e.get("key"), str)}
    target.write_text(json.dumps(receipts))
    target.chmod(0o600)
PY
  install -m 0755 "$here/aico-push" "$sbin/aico-push"
  systemctl --no-ask-password disable --now nightshift-nightwatch.timer nightshift-nightwatch-web.service
  systemctl --no-ask-password stop nightshift-nightwatch.service
fi
echo "Aico Proxmox sender installed."
