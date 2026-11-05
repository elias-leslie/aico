#!/usr/bin/env bash
# Run as root INSIDE CT 190, with the exported Aico native/ directory beside this script.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix="${CT_HEARTBEAT_PREFIX:-/usr/local/lib/host-steward}"
units="${CT_HEARTBEAT_UNITS:-/etc/systemd/system}"
install -d -m 0755 "$prefix/host_steward/data" "$units"
install -m 0644 "$here/../host-steward/host_steward/heartbeat.py" "$prefix/host_steward/heartbeat.py"
install -m 0644 "$here/../host-steward/aico_status.py" "$prefix/aico_status.py"
touch "$prefix/host_steward/__init__.py"
python3 - "$here/../host-steward/host_steward/data/heartbeat.json" "$prefix/host_steward/data/heartbeat.json" <<'PY'
import json
import sys
from pathlib import Path
cfg = json.loads(Path(sys.argv[1]).read_text())
cfg.update(source="ct190", ssh=["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "pve-alerts"],
           floor_ids=["aico/notify-outbox"])
cfg.pop("route", None)
cfg.pop("sync_command", None)
Path(sys.argv[2]).write_text(json.dumps(cfg, indent=2) + "\n")
PY
# The existing pve-alerts alias/key belongs to the owner account and remains a forced push command.
sed '/Type=oneshot/a User=kasadis\nGroup=kasadis' "$here/../host-steward/systemd/host-steward-heartbeat.service" > "$units/host-steward-heartbeat.service"
install -m 0644 "$here/../host-steward/systemd/host-steward-heartbeat.timer" "$units/"
if [ "${CT_HEARTBEAT_NO_SYSTEMCTL:-0}" != 1 ]; then
  systemctl --no-ask-password daemon-reload
  systemctl --no-ask-password start host-steward-heartbeat.service
  systemctl --no-ask-password enable --now host-steward-heartbeat.timer
fi
echo "CT 190 Aico heartbeat installed."
