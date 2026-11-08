#!/usr/bin/env bash
# Put on a standalone full peer (CT 190) the tools the st launcher shells out to that are not part of
# the Aico release: the guard hook and the browser runtime. The peer has no checkout, no Go and no deploy
# of its own. peer-release.sh runs this after each release; by hand:
#
#   scripts/peer-tools.sh <ssh-host>          e.g. aico-gem
#
# - aico-hook (`st sessions inbox|lease`, the edit guard): the workstation's installed release folder
#   (binary, data, Pi extension), copied to the same ~/.local/lib/aico/hook/releases/NAME, with `current`,
#   `previous` and ~/.local/bin/aico-hook moved over. The binary needs only an older glibc than the peer's.
# - browser-automation: the workstation's accepted release, copied without its `.venv` (a venv holds
#   absolute paths and the workstation's Python) into the same releases/ID folder under the peer's service
#   state. The peer builds its own .venv from the locked dependencies (`uv sync --frozen`; it needs network
#   access, and uv is copied over once if it has none). `st browser` runs it from `current/source`.
# - agent-browser: the pinned npm package the workstation runs (package.json + package-lock.json), installed
#   with `npm ci` in the peer's ~/.local/share/agent-browser-managed.
# The browser VM, its SSH key and the Proxmox firewall are host configuration (docs/deployment.md,
# "Browser on CT 190"). The last line says what happened.
set -euo pipefail

HOST="${1:?usage: scripts/peer-tools.sh <ssh-host>}"
OWNER=browser-automation
STATE="${SUMMITFLOW_SERVICE_STATE_ROOT:-$HOME/.summitflow/services}/projects/$OWNER"
AGENT_BROWSER="$HOME/.local/share/agent-browser-managed"
HOOK="$HOME/.local/lib/aico/hook"
fail() { echo "peer-tools: $*" >&2; exit 1; }
ssh_peer() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$@"; }

current="$(readlink -f "$STATE/current" 2>/dev/null || true)"
[ -d "$current/source" ] || fail "no accepted $OWNER runtime here ($STATE/current); deploy it first: st service rebuild $OWNER"
id="$(basename "$current")"
remote_state="$(ssh_peer 'printf %s "${SUMMITFLOW_SERVICE_STATE_ROOT:-$HOME/.summitflow/services}"')/projects/$OWNER"

changed=""

hook_dir="$(readlink -f "$HOOK/current" 2>/dev/null || true)"
if [ -x "$hook_dir/aico-hook" ]; then
  hook_id="$(basename "$hook_dir")"
  if [ "$(ssh_peer "basename \"\$(readlink -f \"\$HOME/.local/lib/aico/hook/current\" 2>/dev/null)\"" 2>/dev/null || true)" != "$hook_id" ]; then
    ssh_peer 'mkdir -p "$HOME/.local/lib/aico/hook/releases" "$HOME/.local/bin"'
    rsync -a --delete -e "ssh -o BatchMode=yes" "$hook_dir/" "$HOST:.local/lib/aico/hook/releases/$hook_id/"
    ssh_peer "cd \"\$HOME/.local/lib/aico/hook\" && { [ ! -e current ] || ln -sfn \"\$(readlink -f current)\" previous; } && ln -sfn \"releases/$hook_id\" current.new && mv -T current.new current && ln -sfn \"\$HOME/.local/lib/aico/hook/current/aico-hook\" \"\$HOME/.local/bin/aico-hook.new\" && mv -T \"\$HOME/.local/bin/aico-hook.new\" \"\$HOME/.local/bin/aico-hook\" && aico-hook --help >/dev/null 2>&1 || true"
    changed="aico-hook $hook_id"
  fi
fi
have="$(ssh_peer "basename \"\$(readlink -f '$remote_state/current' 2>/dev/null)\"" 2>/dev/null || true)"
if [ "$have" != "$id" ] || ! ssh_peer "test -x '$remote_state/releases/$id/source/.venv/bin/browser-st'"; then
  ssh_peer "command -v uv >/dev/null || test -x \"\$HOME/.local/bin/uv\"" ||
    { ssh_peer 'mkdir -p "$HOME/.local/bin"' && scp -q "$(command -v uv)" "$HOST:.local/bin/uv"; }
  ssh_peer "mkdir -p '$remote_state/releases/$id'"
  rsync -a --delete --exclude=.venv --exclude=__pycache__ -e "ssh -o BatchMode=yes" \
    "$current/" "$HOST:$remote_state/releases/$id/"
  ssh_peer "cd '$remote_state/releases/$id/source' && PATH=\"\$HOME/.local/bin:\$PATH\" uv sync --frozen --no-dev --python-preference system -q"
  ssh_peer "test -x '$remote_state/releases/$id/source/.venv/bin/browser-st'" || fail "$HOST built no browser-st for $id"
  ssh_peer "cd '$remote_state' && { [ ! -e current ] || ln -sfn \"\$(readlink -f current)\" previous; } && ln -sfn '$remote_state/releases/$id' current.new && mv -T current.new current"
  changed="$OWNER ${id:0:8}"
fi

if [ -r "$AGENT_BROWSER/package-lock.json" ]; then
  remote_ab='$HOME/.local/share/agent-browser-managed'
  want="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["packages"]["node_modules/agent-browser"]["version"])' "$AGENT_BROWSER/package-lock.json")"
  if ! ssh_peer "test -x $remote_ab/node_modules/.bin/agent-browser && $remote_ab/node_modules/.bin/agent-browser --version | grep -q 'agent-browser $want\$'"; then
    ssh_peer "mkdir -p $remote_ab"
    scp -q "$AGENT_BROWSER/package.json" "$AGENT_BROWSER/package-lock.json" "$HOST:.local/share/agent-browser-managed/"
    ssh_peer "cd $remote_ab && npm ci --no-audit --no-fund >/dev/null"
    changed="${changed:+$changed, }agent-browser ${want:-?}"
  fi
fi
if [ -n "$changed" ]; then echo "$HOST tools updated ($changed)."; else echo "$HOST tools already current ($OWNER ${id:0:8})."; fi
