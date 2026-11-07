#!/usr/bin/env bash
# Install the root-owned backup helpers on this workstation (run as the owner; sudo installs them). Aico's backups
# call them by these paths (packages/ops/data/backups.json) with sudo -n from their aico-backup-* units, which the
# host-steward sudo check trusts as Aico's automation; the names are the installed ones from before Aico.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for helper in summitflow-backup-window summitflow-native-capture summitflow-snapshot-delete summitflow-steward-receipt; do
  sudo install -o root -g root -m 0755 "$here/$helper" "/usr/local/sbin/$helper"
done
echo "backup helpers installed in /usr/local/sbin"
