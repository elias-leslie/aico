#!/usr/bin/env bash
# Owner-authorized one-time append-only client. No existing keys, repositories or passwords change.
# Arguments: existing Proxmox SSH alias, client CT id, repository CT id, local user.
set -euo pipefail
pve=${1:?Proxmox alias}
client=${2:?client CT id}
store=${3:?repository CT id}
owner=${4:?local user}
[[ $client =~ ^[0-9]+$ && $store =~ ^[0-9]+$ && $owner =~ ^[a-z][a-z0-9_-]*$ ]]
ssh -o BatchMode=yes "$pve" bash -s -- "$client" "$store" "$owner" "${RESTIC_STORE_BIN:-/usr/local/bin/restic}" <<'PVE'
set -euo pipefail
client=$1 store=$2 owner=$3 restic_bin=$4
secret=/home/$owner/.local/state/aico/secrets
label=aico-ct${client}
repo=/srv/restic/$label
password=/etc/restic-append/$label.password
helper=/usr/local/sbin/$label-append
# Generate on the client, with no secret bytes crossing stdout to the caller.
pct exec "$client" -- runuser -u "$owner" -- sh -s -- "$secret" <<'CLIENT'
set -eu
secret=$1
umask 077
mkdir -p "$secret"
chmod 700 "$secret"
test -f "$secret/backup-append.ed25519" || ssh-keygen -q -t ed25519 -N '' -C aico-append-only -f "$secret/backup-append.ed25519" >/dev/null
test -f "$secret/backup-append.password" || head -c 48 /dev/urandom | base64 > "$secret/backup-append.password"
chmod 600 "$secret/backup-append.ed25519" "$secret/backup-append.password"
CLIENT
# A protected temporary file is transferred directly between containers, never returned by SSH.
umask 077
stage=$(mktemp -d /run/aico-append.XXXXXX)
trap 'rm -f "$stage/password"; rmdir "$stage"' EXIT
pct exec "$client" -- cat "$secret/backup-append.password" > "$stage/password"
if ! pct exec "$store" -- test -f "$repo/config"; then
  group=$(pct exec "$store" -- id -g restic)
  pct push "$store" "$stage/password" "$password" --perms 0440 --user 0 --group "$group"
  pct exec "$store" -- install -d -m 0750 -o restic -g restic "$repo"
  pct exec "$store" -- runuser -u restic -- "$restic_bin" --repo "$repo" --password-file "$password" init >/dev/null
fi
# Each key has a fixed add-only destination. SSH_ORIGINAL_COMMAND is deliberately ignored.
if ! test -e "$helper"; then
  printf '#!/bin/sh\nexec /usr/sbin/pct exec %s -- /usr/sbin/runuser -u restic -- /usr/local/bin/rclone serve restic --stdio --append-only --config /dev/null --log-level ERROR %s\n' "$store" "$repo" > "$helper"
  chmod 0755 "$helper"
fi
marker=/var/lib/restic-append-$label-installed
if ! test -e "$marker"; then
  install -d -m 0700 /root/.ssh
  printf 'restrict,command="%s" ' "$helper" >> /root/.ssh/authorized_keys
  pct exec "$client" -- cat "$secret/backup-append.ed25519.pub" >> /root/.ssh/authorized_keys
  chmod 0600 /root/.ssh/authorized_keys
  touch "$marker"
fi
printf 'Append-only client installed: CT %s; repository in CT %s. No secret was printed.\n' "$client" "$store"
PVE
