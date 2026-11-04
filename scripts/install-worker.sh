#!/usr/bin/env bash
# Install built Aico worker artifacts and public trust/config files. Starts nothing.
# Usage: install-worker.sh RELEASE FLEET_CONFIG PEER_PINS UPDATE_PINS TOOL_COMMANDS
set -euo pipefail
[ "$#" = 5 ] || { echo 'Usage: install-worker.sh RELEASE FLEET_CONFIG PEER_PINS UPDATE_PINS TOOL_COMMANDS' >&2; exit 2; }
release="$1"
config="$2"
peers="$3"
updates="$4"
commands="$5"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/aico"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
lib="${TETHER_LIB_DIR:-$HOME/.local/lib/tether}"
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
command -v tmux >/dev/null
command -v openssl >/dev/null
install -d -m 0700 "$config_dir" "${XDG_STATE_HOME:-$HOME/.local/state}/aico/secrets"
install -m 0600 "$config" "$config_dir/fleet.json"
install -m 0600 "$commands" "$config_dir/tool-commands.json"
printf '[]\n' > "$config_dir/worker-hosts.json"
chmod 0600 "$config_dir/worker-hosts.json"
sudo install -d -m 0755 /etc/aico
sudo install -o root -g root -m 0644 "$peers" /etc/aico/fleet-peers.json
sudo install -o root -g root -m 0644 "$updates" /etc/aico/update-pins.json
# Verify with this trusted installer, before executing any candidate code.
node --input-type=module - "$release" /etc/aico/update-pins.json <<'JS'
import {createHash, createPublicKey, verify} from 'node:crypto'
import {lstatSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
try {
  const [release, pins] = process.argv.slice(2)
  const stat = lstatSync(pins)
  if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022) throw Error()
  const keys = JSON.parse(readFileSync(pins, 'utf8')).keys
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 4 || new Set(keys).size !== keys.length) throw Error()
  const envelope = JSON.parse(readFileSync(join(release, 'signed-update.json'), 'utf8'))
  const valid = keys.some(value => {
    const key = createPublicKey({key:Buffer.from(value,'base64'),type:'spki',format:'der'})
    return key.asymmetricKeyType === 'ed25519' && verify(null,Buffer.from('aico-signed-update-v1\n'+envelope.payload),key,Buffer.from(envelope.signature,'base64'))
  })
  if (!valid) throw Error()
  const payload = JSON.parse(envelope.payload)
  const paths = ['dist/tether.mjs','bin/tether','scripts/install-release.sh','scripts/install-shims.sh','scripts/aico-root-watch.py','scripts/aico-blank-slate','shims/tether-shim','shims/shims.list']
  if (payload.format !== 'aico-update-v1' || !Number.isSafeInteger(payload.apiVersion) || payload.apiVersion < 1 || !Number.isSafeInteger(payload.issuedAt) || payload.issuedAt < 1 || !Array.isArray(payload.files) || payload.files.length !== paths.length) throw Error()
  if (payload.files.some((file,i) => file.path !== paths[i] || file.body !== readFileSync(join(release,paths[i])).toString('base64'))) throw Error()
  const hash = value => createHash('sha256').update(value).digest('hex')
  if (hash(JSON.stringify(payload.files)) !== payload.releaseHash || hash(readFileSync(join(release,'dist/tether.mjs'))) !== payload.bundleHash) throw Error()
  console.log('Signed release verified')
} catch {
  console.error('Signed release verification failed; nothing installed')
  process.exit(1)
}
JS
if [ ! -d "$release/scripts/shims" ]; then
  mkdir -p "$release/scripts/shims"
  cp "$release/shims/tether-shim" "$release/shims/shims.list" "$release/scripts/shims/"
fi
TETHER_LIB_DIR="$lib" bash "$release/scripts/install-release.sh"
# Replace the old credential-fetching links with local Aico launchers. The command
# map is host config, contains no credentials, and names the real tool executables.
python3 - "$config_dir/tool-commands.json" "$lib/bin/tether" <<'PY'
import json, os, re, shlex, sys
from pathlib import Path
commands = json.loads(Path(sys.argv[1]).read_text())
root = Path.home()/'.local/lib/aico/auth-bin'
root.mkdir(parents=True, exist_ok=True)
for entry in commands:
    tool, command, executable = entry['tool'], entry['command'], entry['executable']
    if not re.fullmatch('[a-z0-9][a-z0-9-]*', tool) or not re.fullmatch('[a-z0-9][a-z0-9-]*', command) or not Path(executable).is_absolute():
        raise SystemExit('Invalid tool command map')
    wrapper = root/command
    temporary = root/(command+'.new')
    temporary.write_text('#!/bin/sh\nexec '+shlex.join([sys.argv[2], 'fleet', 'tool', tool, '--', executable])+' "$@"\n')
    temporary.chmod(0o755)
    temporary.replace(wrapper)
    legacy = Path.home()/'.local/lib/agent-hub/cred-bin'/command
    if legacy.is_symlink():
        legacy.unlink()
        legacy.symlink_to(wrapper)
PY
install -d -m 0755 "$unit_dir/tether@default.service.d"
cat > "$unit_dir/tether@default.service.d/20-aico-worker.conf" <<EOF
[Service]
ExecStart=
ExecStart=$lib/bin/tether --instance default serve
ExecStartPre=
Environment=TETHER_HOSTS_FILE=$config_dir/worker-hosts.json
Environment=AICO_FLEET_CONFIG=$config_dir/fleet.json
Environment=PATH=$HOME/.local/lib/aico/auth-bin:$HOME/.claude/bin:$HOME/.codex/bin:$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/bin:/bin
EOF
systemctl --user --no-ask-password daemon-reload
echo 'Aico worker installed; no UI or data sync service was installed or started.'
