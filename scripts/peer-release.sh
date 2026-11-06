#!/usr/bin/env bash
# Keep a standalone full peer (CT 190) on what the workstation runs. The aico-jobs job peer-release
# (packages/jobs/data/jobs.json) runs this after routine deploys; by hand:
#
#   scripts/peer-release.sh <ssh-host> <fleet-machine>     e.g. aico-gem aico
#
# - The Aico release: when the peer runs another commit, scripts/deploy-remote.sh sends the one the
#   workstation runs now (it keeps the peer's Tether when that release built none).
# - Tether: the workstation's installed, signed Tether goes over the fleet link with
#   `tether fleet push-update`; the peer installs it only when it differs and is newer.
# While a deploy holds this machine's releases lock, the run does nothing and the next one sends it.
# The last line says what happened (the job's Status meaning).
set -euo pipefail

HOST="${1:?usage: scripts/peer-release.sh <ssh-host> <fleet-machine>}"
MACHINE="${2:?usage: scripts/peer-release.sh <ssh-host> <fleet-machine>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASES="${AICO_RELEASES_DIR:-$HOME/.local/lib/aico/releases}"
TETHER="${TETHER_BIN:-$HOME/.local/bin/tether}"
TETHER_LIB="${TETHER_LIB_DIR:-$HOME/.local/lib/tether}"

mkdir -p "$RELEASES"
# Shared: a deploy (exclusive) waits for this run, and this run never starts during a deploy.
exec 9>>"$RELEASES/.deploy.flock"
flock -s -n 9 || {
  echo "A deploy is running here; the next run sends its release to $MACHINE."
  exit 0
}

want="$(basename "$(readlink -f "$HOME/.local/lib/aico/ops")")"
have="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'basename "$(readlink -f "$HOME/.local/lib/aico/ops")"')"
release="already ran ${want:0:8}"
if [ "$have" != "$want" ]; then
  if command -v nightshift >/dev/null; then
    nightshift declare --host "$MACHINE" --what units --hours 1 \
      --reason "Aico release ${want:0:8} to $MACHINE (peer-release job: copy, install --prebuilt, restart Aico units)" >/dev/null ||
      echo "peer-release: could not declare the change to Nightshift; deploying anyway" >&2
  fi
  "$HERE/deploy-remote.sh" "$HOST" --sha "$want"
  release="now runs ${want:0:8} (was ${have:0:8})"
fi

tether="$("$TETHER" fleet push-update "$MACHINE" "$TETHER_LIB" 2>&1 | tail -n 1)" || {
  echo "$MACHINE $release, but its Tether update failed: $tether"
  exit 1
}
echo "$MACHINE $release. Tether: ${tether:-sent}"
