#!/usr/bin/env bash
# The standby's disk is small and nothing else watches it (host-steward isn't installed there). Fails the
# routine, and so shows on Status, when the disk holding the data folder has less than MIN_FREE_GIB free.
# Names the biggest folders of the data folder so the row says what grew. Runs hourly on the standby only
# (packages/jobs). Usage: standby-disk.sh MIN_FREE_GIB
set -u

min_free="${1:?usage: standby-disk.sh MIN_FREE_GIB}"
dir="${AICO_DATA_DIR:-$HOME/.local/state/aico}"

read -r total free < <(df -Pk "$dir" | awk 'NR==2 { print $2, $4 }')
free_gib=$((free / 1048576))
total_gib=$((total / 1048576))
if [ "$free_gib" -ge "$min_free" ]; then
  echo "${free_gib} GiB free of ${total_gib}."
  exit 0
fi
big=$(du -xk --max-depth=1 "$dir" 2>/dev/null | sort -rn | sed -n 2,3p |
  awk -v d="$dir" '{ gsub(d "/", "", $2); printf "%s %.1f GiB; ", $2, $1 / 1048576 }')
echo "Only ${free_gib} GiB free of ${total_gib} GiB. Biggest in the data folder: ${big%; }."
exit 1
