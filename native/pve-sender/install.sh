#!/usr/bin/env bash
# Run as root on gem, from an exported Aico native/ directory. Existing credentials stay in place.
# The credentials file is /etc/aico/pve-sender-creds.json; it is copied once from the old
# /etc/nightshift/deadman/creds.json when missing.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix="${PVE_SENDER_PREFIX:-/usr/local/lib/aico-pve-sender}"
units="${PVE_SENDER_UNITS:-/etc/systemd/system}"
sbin="${PVE_SENDER_SBIN:-/usr/local/sbin}"
config="${PVE_SENDER_CONFIG:-/etc/aico/pve-sender.json}"
guard_config="${PVE_BACKUP_GUARD_CONFIG:-$(dirname "$config")/backup-guard.json}"
steward="${PVE_SENDER_STEWARD:-/usr/local/lib/host-steward}"
install -d -m 0755 "$prefix/pve_sender" "$units" "$sbin" "$steward"
install -d -m 0755 "$(dirname "$config")"
install -m 0644 "$here"/pve_sender/*.py "$prefix/pve_sender/"
install -m 0755 "$here/pve-sender" "$prefix/pve-sender"
install -m 0755 "$here/aico-backup-guard" "$prefix/aico-backup-guard"
ln -sfn "$prefix/pve-sender" "$sbin/pve-sender"
ln -sfn "$prefix/aico-backup-guard" "$sbin/aico-backup-guard"
if [ ! -f "$config" ]; then install -m 0644 "$here/config.json" "$config"; fi
install -d -m 0755 "$(dirname "$guard_config")"
if [ ! -f "$guard_config" ]; then install -m 0644 "$here/backup-guard.json" "$guard_config"; fi
# An installed config that still names the old credential and token paths is pointed at the Aico ones.
python3 - "$config" <<'PY'
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
cfg = json.loads(path.read_text())
new = {"credentials": "/etc/aico/pve-sender-creds.json", "token_cache": "/var/lib/aico/pve-sender/fcm-token.json"}
if any("nightshift" in str(cfg.get(k, "")) for k in new):
    cfg.update(new)
    path.write_text(json.dumps(cfg, indent=2) + "\n")
PY
creds="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("credentials", "/etc/aico/pve-sender-creds.json"))' "$config")"
old_creds="${PVE_SENDER_OLD_CREDS:-/etc/nightshift/deadman/creds.json}"
if [ ! -f "$creds" ] && [ -f "$old_creds" ]; then
  install -d -m 0755 "$(dirname "$creds")"
  install -m 0600 -o root -g root "$old_creds" "$creds"
fi
# These are Aico's own host-check evaluators, used locally without enabling workstation controllers on PVE.
cp -a "$here/../host-steward/host_steward" "$steward/"
install -m 0644 "$here/../host-steward/aico_status.py" "$steward/aico_status.py"
install -m 0644 "$here"/systemd/* "$units/"
if [ "${PVE_SENDER_NO_SYSTEMCTL:-0}" != 1 ]; then
  /usr/bin/python3 -c 'import cryptography' # distro dependency, present on gem
  systemctl --no-ask-password daemon-reload
  systemctl --no-ask-password enable aico-backup-guard.service
  systemctl --no-ask-password restart aico-backup-guard.service
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
fi
echo "Aico Proxmox sender installed."
