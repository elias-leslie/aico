#!/usr/bin/env bash
# Tether lifecycle integration harness (docs/LIFECYCLE_HARNESS.md).
#
#   scripts/tether-lifecycle-harness.sh [INSTANCE]     default instance: dev
#
# Drives a RUNNING non-default Tether instance through its control socket with
# synthetic `sleep` workloads in shell sessions, and proves Aico's containment
# contract end to end: clean server environment, per-pane scopes, detached
# children, client crash, resize claim, replacement, pane exit, End, and zero
# residue. It refuses the default instance. It touches only sessions it
# created, their exact scopes, and (if this run left it empty) the exact tmux
# server unit those sessions used.
set -Eeuo pipefail
unset TMUX TMUX_PANE

instance=${1:-dev}
[[ $instance =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "invalid instance: $instance" >&2; exit 2; }
[[ $instance != default ]] || { echo 'refusing the default instance' >&2; exit 2; }
uid=$(id -u)
sock="${XDG_RUNTIME_DIR:-/run/user/$uid}/tether/$instance/control.sock"
[[ -S $sock ]] || { echo "tether@$instance is not listening at $sock" >&2; exit 2; }
wait_seconds=${TETHER_HARNESS_WAIT_SECONDS:-15}
run_id="$(date +%s)-$$"
work=$(mktemp -d "/tmp/tether-harness-$run_id.XXXXXX")
chmod 700 "$work"
app_slice="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/app.slice"
created=()
client_pids=()
passed=0

log() { printf '%s\n' "$*"; }
pass() { passed=$((passed + 1)); log "PASS $*"; }
die() { log "FAIL $*"; exit 1; }

# api METHOD PATH [JSON] -> body on stdout; status in $work/status
api() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS --unix-socket "$sock" -X "$method" -o "$work/body" -w '%{http_code}' --max-time 30)
  [[ -n $body ]] && args+=(-H 'content-type: application/json' --data "$body")
  curl "${args[@]}" "http://tether$path" >"$work/status"
  cat "$work/body"
}
status() { cat "$work/status"; }
expect_status() { [[ $(status) == "$1" ]] || die "$2: HTTP $(status) $(cat "$work/body")"; }

wait_until() { # wait_until DESCRIPTION COMMAND...
  local what=$1; shift
  local deadline=$((SECONDS + wait_seconds))
  until "$@" >/dev/null; do
    ((SECONDS < deadline)) || die "timed out waiting for $what"
    sleep 0.1
  done
}

unit_state() { systemctl --user show "$1" -p ActiveState --value 2>/dev/null || echo unknown; }
unit_gone() { local s; s=$(unit_state "$1"); [[ $s == inactive || $s == failed || $s == unknown || -z $s ]]; }
scope_procs() { cat "$app_slice/$1/cgroup.procs" 2>/dev/null || true; }
proc_is() { [[ -r /proc/$1/cmdline ]] && [[ $(tr '\0' ' ' <"/proc/$1/cmdline") == "$2 " ]]; }
pid_of_in_scope() { # SCOPE CMDLINE
  local pid
  for pid in $(scope_procs "$1"); do proc_is "$pid" "$2" && { echo "$pid"; return 0; }; done
  return 1
}
env_of() { tr '\0' '\n' <"/proc/$1/environ"; }
pane_pid() { /usr/bin/tmux -S "$1" display-message -p -t "$2" '#{pane_pid}'; }
scope_of() { sed -n 's#^0::.*/##p' "/proc/$1/cgroup"; }
jqr() { jq -r "$1" <<<"$2"; }

cleanup() {
  local code=$? id generation pid
  for pid in "${client_pids[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  for id in "${created[@]}"; do
    generation=$(api GET "/v1/sessions/$id" 2>/dev/null | jq -r '.generation // empty' 2>/dev/null || true)
    [[ -n $generation ]] && api POST "/v1/sessions/$id/end" "{\"generation\":\"$generation\"}" >/dev/null 2>&1 || true
  done
  rm -rf -- "$work"
  if ((code != 0)); then log "RESULT passed=false run_id=$run_id checks=$passed"; fi
  exit "$code"
}
trap cleanup EXIT INT TERM HUP

# --- 0. instance health ------------------------------------------------------
health=$(api GET /v1/health)
expect_status 200 health
[[ $(jqr .instance "$health") == "$instance" ]] || die "socket answered as another instance"
wait_until 'lifecycle ready' bash -c "curl -sS --unix-socket '$sock' http://tether/v1/health | jq -e '.lifecycle == \"ready\"' >/dev/null"
pass "tether@$instance healthy, lifecycle ready, non-default"

# --- 1. create two contained shell sessions ----------------------------------
create() {
  api POST /v1/sessions "{\"tool\":\"shell\",\"origin\":\"cli\",\"name\":\"harness $run_id $1\",\"size\":{\"cols\":100,\"rows\":30}}"
}
a=$(create A); expect_status 201 'create A'
a_id=$(jqr .id "$a"); created+=("$a_id")
b=$(create B); expect_status 201 'create B'
b_id=$(jqr .id "$b"); created+=("$b_id")
[[ $(jqr .status "$a") == running && $(jqr .status "$b") == running ]] || die 'sessions not running'
socket=$(jqr .tmux.socket "$a")
server_id=$(jqr .tmux.serverId "$a")
[[ $(jqr .tmux.serverId "$b") == "$server_id" ]] || die 'sessions on different servers'
server_unit="tether-$instance-tmux-server-$server_id.service"
pass "created running shell sessions $a_id and $b_id on server $server_id"

# --- 2. server: exact manager-spawned service with a clean environment ---------
[[ $(unit_state "$server_unit") == active ]] || die "$server_unit not active"
[[ $(systemctl --user show "$server_unit" -p ExitType --value) == cgroup ]] || die 'ExitType is not cgroup'
[[ $(systemctl --user show "$server_unit" -p StandardInput --value) == null ]] || die 'stdin is not null'
server_pid=$(/usr/bin/tmux -S "$socket" display-message -p '#{pid}')
[[ $(scope_of "$server_pid") == "$server_unit" ]] || die "server pid $server_pid not in $server_unit"
server_env=$(env_of "$server_pid")
grep -Fxq 'AICO_OWNER=aico' <<<"$server_env" || die 'server lacks AICO_OWNER'
grep -Fxq "AICO_TMUX_SERVER_ID=$server_id" <<<"$server_env" || die 'server lacks its generation marker'
for leaked in INVOCATION_ID JOURNAL_STREAM MANAGERPID TETHER_INSTANCE TMUX; do
  ! grep -q "^$leaked=" <<<"$server_env" || die "server inherited $leaked (env -i not applied)"
done
while IFS='=' read -r name _; do
  case $name in
    HOME | USER | LOGNAME | SHELL | PATH | LANG | LANGUAGE | TZ | EDITOR | VISUAL | PAGER | DISPLAY | \
      WAYLAND_DISPLAY | XAUTHORITY | DBUS_SESSION_BUS_ADDRESS | SSH_AUTH_SOCK | GPG_AGENT_INFO | \
      COLORTERM | CLICOLOR | LC_* | XDG_* | AICO_OWNER | AICO_WORKLOAD_CLASS | AICO_TMUX_SERVER_ID) ;;
    *) die "server environment has non-allow-listed $name" ;;
  esac
done <<<"$server_env"
pass "server pid $server_pid is in $server_unit (ExitType=cgroup, null stdin, allow-listed env only)"

# --- 3. panes: distinct narrow scopes and exact markers -------------------------
a_pane=$(jqr .tmux.paneId "$a"); b_pane=$(jqr .tmux.paneId "$b")
a_pid=$(pane_pid "$socket" "$a_pane"); b_pid=$(pane_pid "$socket" "$b_pane")
a_scope=$(scope_of "$a_pid"); b_scope=$(scope_of "$b_pid")
[[ $a_scope =~ ^tmux-spawn-[0-9a-f-]{36}\.scope$ && $b_scope =~ ^tmux-spawn-[0-9a-f-]{36}\.scope$ ]] ||
  die "panes not in narrow scopes: $a_scope $b_scope"
[[ $a_scope != "$b_scope" ]] || die 'panes share a scope'
for pair in "$a_id:$a_pid" "$b_id:$b_pid"; do
  id=${pair%%:*}; pid=${pair##*:}
  pane_env=$(env_of "$pid")
  for marker in AICO_OWNER=aico AICO_WORKLOAD_CLASS=durable-session "AICO_WIDGET_ID=$id" \
    "AICO_SESSION_ID=aico-widget-$id" AICO_AGENT_SLUG=shell AICO_LIFECYCLE_VERSION=1 \
    "AICO_TMUX_SERVER_ID=$server_id"; do
    grep -Fxq "$marker" <<<"$pane_env" || die "pane $id lacks $marker"
  done
  ! grep -q '^AICO_TMUX_SOCKET=' <<<"$pane_env" || die "pane $id exports AICO_TMUX_SOCKET"
  ! grep -q '^A_TERM_SESSION_ID=' <<<"$pane_env" || die "cli pane $id has A_TERM_SESSION_ID"
done
diag=$(api GET "/v1/sessions/$a_id/diagnostics"); expect_status 200 diagnostics
[[ $(jqr .ownership.scopeUnit "$diag") == "$a_scope" && $(jqr .ownership.launchState "$diag") == dispatched ]] ||
  die 'diagnostics disagree with the observed scope'
pass "panes in distinct scopes $a_scope / $b_scope with exact markers, no AICO_TMUX_SOCKET"

# --- 4. synthetic workloads with detached setsid children -----------------------
start_work() { # ID GENERATION FOREGROUND DETACHED
  api POST "/v1/sessions/$1/inject" \
    "{\"generation\":\"$2\",\"mode\":\"paste\",\"submit\":true,\"text\":\"setsid -f sleep $4; sleep $3\"}" >/dev/null
  expect_status 200 "inject $1"
}
a_gen=$(jqr .generation "$a"); b_gen=$(jqr .generation "$b")
fa=$((300000 + RANDOM)); da=$((400000 + RANDOM)); fb=$((500000 + RANDOM)); db=$((600000 + RANDOM))
start_work "$a_id" "$a_gen" "$fa" "$da"
start_work "$b_id" "$b_gen" "$fb" "$db"
wait_until 'A workloads' pid_of_in_scope "$a_scope" "sleep $da"
wait_until 'B workloads' pid_of_in_scope "$b_scope" "sleep $db"
wait_until 'A foreground' pid_of_in_scope "$a_scope" "sleep $fa"
a_detached=$(pid_of_in_scope "$a_scope" "sleep $da"); b_detached=$(pid_of_in_scope "$b_scope" "sleep $db")
env_of "$a_detached" | grep -Fxq "AICO_WIDGET_ID=$a_id" || die 'detached child lost its marker'
[[ $(ps -o sid= -p "$a_detached" | tr -d ' ') == "$a_detached" ]] || die 'child is not a session leader'
pass "setsid children $a_detached / $b_detached stay in their pane scopes with markers"

# --- 5. capture, scrollback, stale fence -------------------------------------------
api GET "/v1/sessions/$a_id/capture" >/dev/null; expect_status 200 capture
api GET "/v1/sessions/$a_id/scrollback?count=50" | jq -e '.totalLines >= 1' >/dev/null || die scrollback
api POST "/v1/sessions/$a_id/end" "{\"generation\":\"$(printf '0%.0s' {1..64})\"}" >/dev/null
expect_status 409 'stale end'
[[ $(jq -r .error "$work/body") == stale_generation ]] || die 'stale end not refused as stale_generation'
pass 'capture, scrollback and the stale-generation fence work'

# --- 5b. view mutations without a GUI: title renames, show/position refuse ----------
gen=$(api GET "/v1/sessions/$a_id" | jq -r .generation)
api POST "/v1/widgets/$a_id/title" "{\"generation\":\"$gen\",\"label\":\"Harness A\"}" >/dev/null
expect_status 200 'title without GUI'
[[ $(api GET "/v1/sessions/$a_id" | jq -r .name) == 'Harness A' ]] || die 'title did not rename the session'
gen=$(api GET "/v1/sessions/$a_id" | jq -r .generation)
gui=$(api GET /v1/health | jq -r .gui.connected)
moved=$(api POST "/v1/widgets/$a_id/position" "{\"generation\":\"$gen\",\"bounds\":{\"x\":0,\"y\":0,\"width\":800,\"height\":600}}")
if [[ $gui != true ]]; then
  expect_status 503 'position without GUI'
  [[ $(jqr .error "$moved") == gui_unavailable ]] || die 'position without GUI not gui_unavailable'
fi
pass 'title renames through the generation fence without a GUI; position answers gui_unavailable'

# --- 6. real attach client: resize claim, crash, reconnect -------------------------
attach=$(api GET "/v1/sessions/$a_id/attach"); expect_status 200 attach
mapfile -t argv < <(jq -r '.argv[]' <<<"$attach")
[[ ${argv[0]} == /usr/bin/tmux && ${argv[2]} == "$socket" && ${argv[5]} == "$(jqr .tmux.sessionId "$a")" ]] ||
  die "unexpected attach argv ${argv[*]}"
printf -v attach_cmd '%q ' "${argv[@]}"
TERM=xterm-256color setsid script -qfec "$attach_cmd" /dev/null </dev/null >/dev/null 2>&1 &
client_pids+=($!)
disown "$!"
client_count() { [[ $(/usr/bin/tmux -S "$socket" list-clients -t "${argv[5]}" -F '#{client_pid}' | wc -l) == 1 ]]; }
wait_until 'attach client' client_count
client_pid=$(/usr/bin/tmux -S "$socket" list-clients -t "${argv[5]}" -F '#{client_pid}')
claim=$(api POST "/v1/sessions/$a_id/resize-claim" "{\"generation\":\"$a_gen\",\"clientPid\":$client_pid,\"cols\":90,\"rows\":25}")
[[ $(jqr .applied "$claim") == true ]] || die "resize claim refused: $claim"
kill -KILL "$client_pid" "${client_pids[@]}" 2>/dev/null || true
no_clients() { [[ -z $(/usr/bin/tmux -S "$socket" list-clients -t "${argv[5]}" -F '#{client_pid}') ]]; }
wait_until 'client gone' no_clients
[[ $(api GET "/v1/sessions/$a_id" | jq -r .status) == running ]] || die 'session lost after client crash'
proc_is "$a_detached" "sleep $da" || die 'detached child lost after client crash'
TERM=xterm-256color setsid script -qfec "$attach_cmd" /dev/null </dev/null >/dev/null 2>&1 &
client_pids+=($!)
disown "$!"
wait_until 'reconnect' client_count
/usr/bin/tmux -S "$socket" detach-client -s "${argv[5]}"
wait_until 'clean detach' no_clients
pass 'resize claim applied; client crash preserved the session; reconnect and detach succeeded'

# --- 6b. daemon restart never touches durable work --------------------------------
if [[ ${TETHER_HARNESS_RESTART:-1} == 1 ]]; then
  systemctl --user restart "tether@$instance.service"
  ready() { curl -sS --unix-socket "$sock" http://tether/v1/health 2>/dev/null | jq -e '.lifecycle == "ready"'; }
  wait_until 'daemon ready after restart' ready
  for pair in "$a_id:$a_scope:$a_detached:$da" "$b_id:$b_scope:$b_detached:$db"; do
    IFS=: read -r id scope pid n <<<"$pair"
    [[ $(api GET "/v1/sessions/$id" | jq -r .status) == running ]] || die "$id not running after restart"
    [[ $(systemctl --user show "$scope" -p ActiveState --value) == active ]] || die "$scope lost on restart"
    proc_is "$pid" "sleep $n" || die "detached child $pid lost on restart"
  done
  [[ $(api GET "/v1/sessions/$a_id" | jq -r .generation) == "$a_gen" ]] || die 'restart changed a generation'
  pass "restarting tether@$instance kept both sessions, scopes, children and generations"
fi

# --- 7. replacement: new scope, old scope drained, peer intact ----------------------
replaced=$(api POST "/v1/sessions/$a_id/respawn" "{\"generation\":\"$a_gen\"}"); expect_status 200 respawn
a_gen2=$(jqr .generation "$replaced")
[[ $a_gen2 != "$a_gen" ]] || die 'respawn kept the generation'
a_pid2=$(pane_pid "$socket" "$a_pane"); a_scope2=$(scope_of "$a_pid2")
[[ $a_scope2 != "$a_scope" ]] || die 'respawn reused the pane scope'
wait_until 'old scope stopped' unit_gone "$a_scope"
! proc_is "$a_detached" "sleep $da" || die 'old detached child survived replacement'
proc_is "$b_detached" "sleep $db" || die 'peer child lost during replacement'
[[ $(jqr .status "$replaced") == running ]] || die 'replacement not running'
pass "respawn moved $a_id to $a_scope2; old scope and its detached child are gone; peer intact"

# --- 8. pane exit while detached is reconciled -------------------------------------
api POST "/v1/sessions/$a_id/inject" "{\"generation\":\"$a_gen2\",\"mode\":\"paste\",\"submit\":true,\"text\":\"exit\"}" >/dev/null
expect_status 200 'inject exit'
reconciled() {
  local d; d=$(curl -sS --unix-socket "$sock" "http://tether/v1/sessions/$a_id/diagnostics")
  [[ $(jq -r .tmux.state <<<"$d") == absent && $(jq -r .ownership.scopeUnit <<<"$d") == null ]]
}
wait_until 'pane-exit reconciliation' reconciled
wait_until 'exited scope stopped' unit_gone "$a_scope2"
a_gen3=$(api GET "/v1/sessions/$a_id" | jq -r .generation)
api POST "/v1/sessions/$a_id/end" "{\"generation\":\"$a_gen3\"}" >/dev/null; expect_status 200 'end exited A'
pass 'a detached pane exit was reconciled to absent ownership and then ended'

# --- 9. End: exact scope retirement --------------------------------------------------
b_gen_now=$(api GET "/v1/sessions/$b_id" | jq -r .generation)
ended=$(api POST "/v1/sessions/$b_id/end" "{\"generation\":\"$b_gen_now\"}"); expect_status 200 'end B'
[[ $(jqr .status "$ended") == ended ]] || die "unexpected end body $ended"
wait_until 'B scope stopped' unit_gone "$b_scope"
! proc_is "$b_detached" "sleep $db" || die 'B detached child survived End'
api GET "/v1/sessions/$b_id" >/dev/null; expect_status 404 'ended session is gone'
pass "End retired $b_id exactly; its detached child is gone"

# --- 10. residue ------------------------------------------------------------------------
created=()
remaining=$(api GET /v1/sessions | jq --arg s "$server_id" '[.items[] | select(.tmux.serverId == $s)] | length')
if [[ $remaining == 0 ]]; then
  wait_until 'empty server exits' unit_gone "$server_unit"
  [[ ! -S $socket ]] || ! /usr/bin/tmux -S "$socket" list-sessions >/dev/null 2>&1 || die 'server still answers'
  server_note='server exited when empty'
else
  server_note="server kept: $remaining other session(s) on it"
fi
for pid in "$a_detached" "$b_detached"; do kill -0 "$pid" 2>/dev/null && die "pid $pid remains"; done
for scope in "$a_scope" "$a_scope2" "$b_scope"; do unit_gone "$scope" || die "$scope remains"; done
pass "no workload PID, scope or session from this run remains ($server_note)"
log "RESULT passed=true run_id=$run_id checks=$passed scopes=3 sessions=2 detached_children=2 residue=0"
