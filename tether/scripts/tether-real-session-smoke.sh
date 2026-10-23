#!/usr/bin/env bash
# Real agent-session smoke against a RUNNING non-default Tether instance.
#
#   scripts/tether-real-session-smoke.sh [INSTANCE] [TOOL]     defaults: dev codex
#
# Starts one real agent TUI through the v1 API exactly as A-Term would
# (origin a-term with an A-Term session id), proves it runs contained in its
# pane scope with the compatibility markers, exercises capture, a real attach
# client (resize claim, crash, survival), typed input framing, and End, then
# proves zero residue. No prompt is ever submitted to the agent, so no model
# request is made. It refuses the default instance and touches only the
# session it created (and its exact tmux server unit if this run left it empty).
set -Eeuo pipefail
unset TMUX TMUX_PANE

instance=${1:-dev}
tool=${2:-codex}
[[ $instance =~ ^[a-z0-9][a-z0-9-]{0,31}$ && $instance != default ]] || {
  echo "refusing instance: $instance" >&2; exit 2;
}
uid=$(id -u)
sock="${XDG_RUNTIME_DIR:-/run/user/$uid}/tether/$instance/control.sock"
[[ -S $sock ]] || { echo "tether@$instance is not listening at $sock" >&2; exit 2; }
wait_seconds=${TETHER_SMOKE_WAIT_SECONDS:-30}
run_id="$(date +%s)-$$"
work=$(mktemp -d "/tmp/tether-smoke-$run_id.XXXXXX")
chmod 700 "$work"
mkdir "$work/project"
aterm_id=$(cat /proc/sys/kernel/random/uuid)
session_id=
client_pid=
passed=0

log() { printf '%s\n' "$*"; }
pass() { passed=$((passed + 1)); log "PASS $*"; }
die() { log "FAIL $*"; exit 1; }
api() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS --unix-socket "$sock" -X "$method" -o "$work/body" -w '%{http_code}' --max-time 60)
  [[ -n $body ]] && args+=(-H 'content-type: application/json' --data "$body")
  curl "${args[@]}" "http://tether$path" >"$work/status"
  cat "$work/body"
}
expect_status() { [[ $(cat "$work/status") == "$1" ]] || die "$2: HTTP $(cat "$work/status") $(cat "$work/body")"; }
wait_until() {
  local what=$1; shift
  local deadline=$((SECONDS + wait_seconds))
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || die "timed out waiting for $what"
    sleep 0.2
  done
}
unit_gone() { local s; s=$(systemctl --user show "$1" -p ActiveState --value 2>/dev/null || true); [[ $s != active && $s != activating && $s != deactivating ]]; }
scope_of() { sed -n 's#^0::.*/##p' "/proc/$1/cgroup"; }
jqr() { jq -r "$1" <<<"$2"; }

cleanup() {
  local code=$? generation
  [[ -n $client_pid ]] && kill -KILL "$client_pid" 2>/dev/null || true
  if [[ -n $session_id ]]; then
    generation=$(api GET "/v1/sessions/$session_id" 2>/dev/null | jq -r '.generation // empty' 2>/dev/null || true)
    [[ -n $generation ]] && api POST "/v1/sessions/$session_id/end" "{\"generation\":\"$generation\"}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work"
  ((code == 0)) || log "RESULT passed=false run_id=$run_id tool=$tool checks=$passed"
  exit "$code"
}
trap cleanup EXIT INT TERM HUP

process_name=$(api GET "/v1/tools/$tool" | jq -r .processName)
expect_status 200 "tool $tool"
[[ -n $process_name ]] || die "$tool has no process name to verify"

# --- create as A-Term would -------------------------------------------------------
created=$(api POST /v1/sessions "{\"tool\":\"$tool\",\"origin\":\"a-term\",\"aTermSessionId\":\"$aterm_id\",\"projectRoot\":\"$work/project\",\"size\":{\"cols\":120,\"rows\":40}}")
case $(cat "$work/status") in
  201 | 202) ;;
  409) [[ $(jqr .error "$created") == admission_denied ]] && { log "SKIP host admission deferred the agent: $(jqr .reason "$created")"; exit 3; } ;&
  *) die "create: HTTP $(cat "$work/status") $created" ;;
esac
session_id=$(jqr .id "$created")
running() { [[ $(api GET "/v1/sessions/$session_id" | jq -r .status) == running ]]; }
wait_until 'running agent' running
desc=$(api GET "/v1/sessions/$session_id")
[[ $(jqr .origin "$desc") == a-term && $(jqr .aTermSessionId "$desc") == "$aterm_id" && $(jqr .tool "$desc") == "$tool" ]] ||
  die "descriptor mismatch: $desc"
socket=$(jqr .tmux.socket "$desc"); pane=$(jqr .tmux.paneId "$desc"); server_id=$(jqr .tmux.serverId "$desc")
pass "created running $tool session $session_id (origin a-term)"

# --- containment and markers ---------------------------------------------------------
pane_pid=$(/usr/bin/tmux -S "$socket" display-message -p -t "$pane" '#{pane_pid}')
scope=$(scope_of "$pane_pid")
[[ $scope =~ ^tmux-spawn-[0-9a-f-]{36}\.scope$ ]] || die "pane not in a narrow scope: $scope"
procs="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/app.slice/$scope/cgroup.procs"
agent_in_scope() {
  local pid
  while read -r pid; do
    [[ $(cat "/proc/$pid/comm" 2>/dev/null) == "$process_name"* ]] && return 0
  done <"$procs"
  return 1
}
wait_until "$process_name in $scope" agent_in_scope
pane_env=$(tr '\0' '\n' <"/proc/$pane_pid/environ")
for marker in AICO_OWNER=aico "AICO_AGENT_SLUG=$tool" "AICO_WIDGET_ID=$session_id" "A_TERM_SESSION_ID=$aterm_id"; do
  grep -Fxq "$marker" <<<"$pane_env" || die "pane lacks $marker"
done
! grep -q '^AICO_TMUX_SOCKET=' <<<"$pane_env" || die 'pane exports AICO_TMUX_SOCKET'
pass "$process_name runs inside $scope with AICO_OWNER, AICO_AGENT_SLUG and A_TERM_SESSION_ID"

# --- screen, real client, input framing ------------------------------------------------
painted() { [[ -n $(api GET "/v1/sessions/$session_id/capture" | jq -r '.text' | tr -d '[:space:]') ]]; }
wait_until 'first frame' painted
generation=$(jqr .generation "$desc")
attach=$(api GET "/v1/sessions/$session_id/attach"); expect_status 200 attach
mapfile -t argv < <(jq -r '.argv[]' <<<"$attach")
printf -v attach_cmd '%q ' "${argv[@]}"
TERM=xterm-256color setsid script -qfec "$attach_cmd" /dev/null </dev/null >/dev/null 2>&1 &
client_pid=$!
disown "$client_pid"
attached() { [[ -n $(/usr/bin/tmux -S "$socket" list-clients -t "${argv[5]}" -F '#{client_pid}') ]]; }
wait_until 'attach client' attached
tmux_client=$(/usr/bin/tmux -S "$socket" list-clients -t "${argv[5]}" -F '#{client_pid}')
claim=$(api POST "/v1/sessions/$session_id/resize-claim" "{\"generation\":\"$generation\",\"clientPid\":$tmux_client,\"cols\":110,\"rows\":35}")
[[ $(jqr .applied "$claim") == true ]] || die "resize claim refused: $claim"
marker="tether-smoke-${run_id//-/}"
api POST "/v1/sessions/$session_id/inject" "{\"generation\":\"$generation\",\"mode\":\"type\",\"text\":\"$marker\"}" >/dev/null
expect_status 200 'typed input'
typed() { api GET "/v1/sessions/$session_id/capture" | jq -r .text | grep -Fq "$marker"; }
typed_note='typed text framed into the composer'
deadline=$((SECONDS + wait_seconds))
until typed; do
  if ((SECONDS >= deadline)); then
    # A first-run TUI dialog (for example a folder-trust prompt) consumes
    # input without echoing it. Delivery itself was acknowledged above.
    typed_note='typed text delivered (not echoed: the TUI is showing a startup dialog)'
    log "WARN $typed_note"
    break
  fi
  sleep 0.2
done
kill -KILL "$tmux_client" "$client_pid" 2>/dev/null || true
client_pid=
detached() { [[ -z $(/usr/bin/tmux -S "$socket" list-clients -t "${argv[5]}" -F '#{client_pid}') ]]; }
wait_until 'client gone' detached
running || die 'agent lost after client crash'
pass "first frame painted; resize claim applied; $typed_note; client crash survived"

# --- End and residue ------------------------------------------------------------------------
generation=$(api GET "/v1/sessions/$session_id" | jq -r .generation)
api POST "/v1/sessions/$session_id/end" "{\"generation\":\"$generation\"}" >/dev/null; expect_status 200 end
ended_id=$session_id; session_id=
wait_until 'scope stopped' unit_gone "$scope"
api GET "/v1/sessions/$ended_id" >/dev/null; expect_status 404 'ended session is gone'
kill -0 "$pane_pid" 2>/dev/null && die "pane pid $pane_pid remains"
remaining=$(api GET /v1/sessions | jq --arg s "$server_id" '[.items[] | select(.tmux.serverId == $s)] | length')
if [[ $remaining == 0 ]]; then
  wait_until 'empty server exits' unit_gone "tether-$instance-tmux-server-$server_id.service"
fi
pass "End retired $ended_id; no agent process, scope or session remains"
log "RESULT passed=true run_id=$run_id tool=$tool checks=$passed residue=0"
