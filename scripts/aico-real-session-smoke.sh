#!/usr/bin/env bash
# Isolated packaged Aico profile against the real user manager and a private X display.
# Usage: scripts/aico-real-session-smoke.sh dist/electron/Aico-*.AppImage
# On failure this harness stops only its marked AppImage process group and keeps
# the DB, identity snapshot, and logs. Durable units require manual cleanup:
# compare the DB socket path with this run directory and both unit InvocationIDs
# with `systemctl --user show` immediately before stopping those exact units.
# If a scope stays deactivating, inspect its cgroup/PIDs before an exact-unit kill.
set -Eeuo pipefail

[[ $# == 1 && -f $1 ]] || { echo "usage: $0 Aico.AppImage" >&2; exit 2; }
artifact=$(realpath -- "$1")
[[ -n ${XDG_RUNTIME_DIR:-} && -S ${XDG_RUNTIME_DIR}/bus ]] || {
  echo 'A real user D-Bus/XDG_RUNTIME_DIR is required' >&2; exit 2;
}
[[ ${DBUS_SESSION_BUS_ADDRESS:-} == "unix:path=${XDG_RUNTIME_DIR}/bus" ]] || {
  echo 'Refusing a non-user-manager D-Bus address' >&2; exit 2;
}
[[ $(loginctl show-user "$(id -u)" -p Linger --value) == yes ]] || {
  echo 'User manager is not durable (linger=no)' >&2; exit 2;
}

if [[ ${AICO_REAL_SMOKE_IN_XVFB:-} != 1 ]]; then
  run_dir=$(mktemp -d /tmp/ar.XXXXXX)
  chmod 700 "$run_dir"
  # Keep the real bus/runtime while xvfb-run supplies only an isolated display.
  AICO_REAL_SMOKE_IN_XVFB=1 AICO_REAL_SMOKE_DIR="$run_dir" \
    timeout --signal=TERM --kill-after=10s 240s \
    xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' bash "$0" "$artifact"
  exit $?
fi

run_dir=${AICO_REAL_SMOKE_DIR:?}
[[ $run_dir == /tmp/ar.* && -d $run_dir && $(stat -c %u "$run_dir") == "$(id -u)" ]] || {
  echo 'Unsafe smoke directory' >&2; exit 2;
}
run_id=${run_dir##*/}
state_dir=$run_dir/state/aico
db=$state_dir/aico.db
mkdir -p "$run_dir"/{home,config,cache,data,state,temp} "$state_dir"
chmod 700 "$run_dir"/{home,config,cache,data,state,temp} "$state_dir"
private_socket=$run_dir/l.sock
[[ ${#private_socket} -lt 70 ]] || { echo 'Private socket path too long' >&2; exit 2; }

read -r sidecar_port debug_port < <(python3 - <<'PY'
import socket
with socket.socket() as a, socket.socket() as b:
    a.bind(('127.0.0.1', 0))
    b.bind(('127.0.0.1', 0))
    print(a.getsockname()[1], b.getsockname()[1])
PY
)

app_env=(env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  LANG=C.UTF-8 HOME="$run_dir/home" DISPLAY="$DISPLAY" XAUTHORITY="${XAUTHORITY:-}"
  XDG_CONFIG_HOME="$run_dir/config" XDG_CACHE_HOME="$run_dir/cache"
  XDG_DATA_HOME="$run_dir/data" XDG_STATE_HOME="$run_dir/state"
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"
  TMPDIR="$run_dir/temp" AICO_STATE_DIR="$state_dir" AICO_TMUX_SOCKET="$private_socket"
  AICO_SIDECAR_HOST=127.0.0.1 AICO_SIDECAR_PORT="$sidecar_port"
  AICO_REAL_SMOKE_RUN_ID="$run_id" APPIMAGE_EXTRACT_AND_RUN=1)
primary_pid=
artifact_log=$run_dir/app.log

owned_primary() {
  [[ -n $primary_pid && -r /proc/$primary_pid/environ ]] || return 1
  tr '\0' '\n' 2>/dev/null <"/proc/$primary_pid/environ" | grep -Fxq "AICO_REAL_SMOKE_RUN_ID=$run_id"
}
stop_app() {
  if owned_primary; then
    kill -TERM -- "-$primary_pid" 2>/dev/null || true
    for ((i=0; i<40; i++)); do
      owned_primary || break
      sleep 0.1
    done
    if owned_primary; then kill -KILL -- "-$primary_pid" 2>/dev/null || true; fi
    wait "$primary_pid" 2>/dev/null || true
  fi
  primary_pid=
}
cleanup() {
  status=$?
  trap - EXIT
  stop_app
  if (( status != 0 )); then
    echo "FAIL: preserved isolated evidence at $run_dir" >&2
    if [[ -f $run_dir/identity.json ]]; then
      echo 'Manual cleanup required only if these DB-verified private units remain active:' >&2
      python3 - "$run_dir/identity.json" <<'PY' >&2
import json,sys
d=json.load(open(sys.argv[1]))
print('  socket:', d['socket_path'])
print('  pane:', d['pane_scope'], 'InvocationID=', d['pane_inv'])
print('  server:', d['server_scope'], 'InvocationID=', d['server_inv'])
PY
    fi
    tail -n 100 "$artifact_log" >&2 || true
  else
    echo "PASS: evidence at $run_dir (remove after review)"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM INT

start_app() {
  local label=$1
  mkdir -p "$run_dir/temp/primary-$label"
  setsid "${app_env[@]}" TMPDIR="$run_dir/temp/primary-$label" "$artifact" --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --remote-debugging-address=127.0.0.1 "--remote-debugging-port=$debug_port" \
    >>"$artifact_log" 2>&1 &
  primary_pid=$!
  echo "START $label pid=$primary_pid"
}
second_launch() {
  local label=$1 start end
  mkdir -p "$run_dir/temp/$label"
  start=$(date +%s%3N)
  timeout 30s "${app_env[@]}" TMPDIR="$run_dir/temp/$label" "$artifact" --no-sandbox --disable-gpu --disable-dev-shm-usage \
    >"$run_dir/$label.log" 2>&1
  end=$(date +%s%3N)
  echo "LATENCY ${label}_activation_ms=$((end-start))"
}
health_ok() {
  python3 - "$sidecar_port" <<'PY'
import json, sys, urllib.request
try:
    with urllib.request.urlopen(f'http://127.0.0.1:{sys.argv[1]}/health', timeout=1) as res:
        body = json.load(res)
    assert body['status'] == 'ok' and body['service'] == 'aico-sidecar'
except (OSError, KeyError, ValueError, AssertionError):
    sys.exit(1)
PY
}
wait_for() {
  local label=$1 deadline=$2
  shift 2
  until "$@"; do
    owned_primary || { echo "AppImage exited while waiting for $label" >&2; return 1; }
    (( SECONDS < deadline )) || { echo "Timed out waiting for $label" >&2; return 1; }
    sleep 0.25
  done
}
cdp() { node "$(dirname "$0")/aico-real-session-smoke-cdp.mjs" "$debug_port" "$@"; }

identity_ready() {
  [[ -f $db ]] || return 1
  python3 - "$db" "$state_dir" "$run_dir/identity.json" <<'PY'
import json, pathlib, re, sqlite3, sys
db, state, output = sys.argv[1:]
try:
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute('''SELECT w.id widget_id,w.open,w.session_id,w.tmux_session_id,
        w.pane_id,w.scope_unit pane_scope,w.scope_invocation_id pane_inv,
        s.id server_id,s.socket_path,s.scope_unit server_scope,
        s.invocation_id server_inv,s.server_pid,s.phase
        FROM widgets w JOIN tmux_servers s ON s.id=w.tmux_server_id''').fetchall()
    assert len(rows) == 1
    row = dict(rows[0])
    assert row['open'] == 1 and row['phase'] == 'active'
    assert row['socket_path'] == f"{state}/tmux/{row['server_id']}/server.sock"
    assert re.fullmatch(r'[0-9a-f]{32}', row['server_id'])
    assert row['server_scope'] == f"aico-tmux-server-{row['server_id']}.service"
    assert re.fullmatch(r'tmux-spawn-[0-9a-f-]+\.scope', row['pane_scope'])
    assert re.fullmatch(r'[0-9a-f]{32}', row['pane_inv'])
    assert re.fullmatch(r'[0-9a-f]{32}', row['server_inv'])
    assert re.fullmatch(r'%[0-9]+', row['pane_id'])
    pathlib.Path(output).write_text(json.dumps(row, indent=2))
except (sqlite3.Error, AssertionError, TypeError, KeyError):
    sys.exit(1)
PY
}
identity_field() {
  python3 - "$run_dir/identity.json" "$1" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))[sys.argv[2]])
PY
}
unit_field() { systemctl --user show "$1" --property="$2" --value 2>/dev/null; }
verify_identity() {
  local server_scope pane_scope socket session pane_id server_inv pane_inv pane_pid
  server_scope=$(identity_field server_scope)
  pane_scope=$(identity_field pane_scope)
  socket=$(identity_field socket_path)
  session=$(identity_field tmux_session_id)
  pane_id=$(identity_field pane_id)
  server_inv=$(identity_field server_inv)
  pane_inv=$(identity_field pane_inv)
  [[ $(unit_field "$server_scope" InvocationID) == "$server_inv" ]]
  [[ $(unit_field "$pane_scope" InvocationID) == "$pane_inv" ]]
  [[ $(unit_field "$server_scope" ControlGroup) == "/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/$server_scope" ]]
  [[ $(unit_field "$pane_scope" ControlGroup) == "/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/$pane_scope" ]]
  [[ $(unit_field "$server_scope" ActiveState) == active ]]
  [[ $(unit_field "$pane_scope" ActiveState) == active ]]
  [[ -S $socket ]]
  /usr/bin/tmux -S "$socket" has-session -t "$session"
  read -r actual_id pane_pid < <(/usr/bin/tmux -S "$socket" list-panes -t "$session" -F '#{pane_id} #{pane_pid}')
  [[ $actual_id == "$pane_id" && $pane_pid =~ ^[0-9]+$ ]]
  grep -Fq "/$pane_scope" "/proc/$pane_pid/cgroup"
  if [[ -f $run_dir/pane.pid ]]; then
    [[ $(cat "$run_dir/pane.pid") == "$pane_pid" ]] || {
      echo 'Exact pane PID changed across reopen/restart' >&2; return 1;
    }
  else
    echo "$pane_pid" >"$run_dir/pane.pid"
  fi
  echo "IDENTITY widget=$(identity_field widget_id) server=$server_scope/$server_inv pane=$pane_scope/$pane_inv pid=$pane_pid"
  pane_home=$(tr '\0' '\n' <"/proc/$pane_pid/environ" | sed -n 's/^HOME=//p')
  echo "PANE_HOME=$pane_home"
  [[ $pane_home == "$run_dir/home" ]] || {
    echo 'Pane HOME escaped private profile; refusing fixture commands' >&2; return 1;
  }
  printf 'PANE_CWD='; readlink -f "/proc/$pane_pid/cwd"
}
db_open_is() {
  [[ $(sqlite3 -cmd '.timeout 1000' "$db" 'SELECT open FROM widgets LIMIT 1;' 2>/dev/null) == "$1" ]]
}
db_retired() { [[ $(sqlite3 -cmd '.timeout 1000' "$db" 'SELECT count(*) FROM widgets;' 2>/dev/null) == 0 ]]; }
session_alive() { /usr/bin/tmux -S "$(identity_field socket_path)" has-session -t "$(identity_field tmux_session_id)" 2>/dev/null; }
sample_processes() {
  local label=$1
  ps -eo pid=,pgid=,pcpu=,rss=,comm= | awk -v pg="$primary_pid" -v pane="$(cat "$run_dir/pane.pid")" -v server="$(identity_field server_pid)" -v label="$label" \
    '$2 == pg || $1 == pane || $1 == server {print label,$1,$3,$4,$5}' >>"$run_dir/process-metrics.tsv"
}
clear_pane_history() {
  local socket pane prior_count observed_count
  socket=$(identity_field socket_path)
  pane=$(identity_field pane_id)
  prior_count=$(/usr/bin/tmux -S "$socket" capture-pane -p -t "$pane" -S - | grep -Fxc 'AICO_HIST_CLEARED' || true)
  # The shell variables must expand inside the verified private pane.
  # shellcheck disable=SC2016
  /usr/bin/tmux -S "$socket" send-keys -t "$pane" -l \
    'export HISTFILE=/dev/null; history -c; [[ $HISTFILE == /dev/null ]] && [[ $(history | wc -l) -eq 0 ]] && printf "AICO_HIST_CLEARED\n"'
  /usr/bin/tmux -S "$socket" send-keys -t "$pane" Enter
  for ((i=0; i<40; i++)); do
    observed_count=$(/usr/bin/tmux -S "$socket" capture-pane -p -t "$pane" -S - | grep -Fxc 'AICO_HIST_CLEARED' || true)
    if (( observed_count > prior_count )); then
      echo 'PANE_HISTORY cleared and redirected to /dev/null'
      return 0
    fi
    sleep 0.1
  done
  echo 'Pane history mitigation was not confirmed' >&2
  return 1
}

start_app initial
wait_for sidecar "$((SECONDS+90))" health_ok
second_launch second-launch
wait_for identity "$((SECONDS+60))" identity_ready
verify_identity
cdp ready
sample_processes before_output
cdp run-output >"$run_dir/output-profile.json" &
probe_pid=$!
while kill -0 "$probe_pid" 2>/dev/null; do sample_processes during_output; sleep 0.5; done
wait "$probe_pid"
cat "$run_dir/output-profile.json"
sample_processes after_output
awk '{if ($3 > cpu) cpu=$3; if ($4 > rss) rss=$4} END {printf "PROCESS_PROFILE peak_process_cpu_pct=%.1f peak_process_rss_kib=%d samples=%d\n", cpu, rss, NR}' \
  "$run_dir/process-metrics.tsv"
clear_pane_history
cdp scrollback | tee "$run_dir/scrollback-profile.json"
cdp mouse-program "$run_dir" | tee "$run_dir/mouse-program-profile.json"
clear_pane_history
cdp context-send "$sidecar_port" | tee "$run_dir/context-profile.json"
cdp close
wait_for closed "$((SECONDS+10))" db_open_is 0
session_alive
echo 'CLOSE preserved exact tmux session'
second_launch reopen
wait_for reopened "$((SECONDS+30))" db_open_is 1
cdp ready
verify_identity
echo 'REOPEN preserved exact pane'
stop_app
session_alive
start_app restart
wait_for restart_sidecar "$((SECONDS+90))" health_ok
cdp ready
verify_identity
echo 'RESTART preserved exact pane'
cdp retire | tee "$run_dir/retire-profile.json"
wait_for retired "$((SECONDS+30))" db_retired
retire_click_ms=$(python3 - "$run_dir/retire-profile.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['confirmedAtMs'])
PY
)
echo "LATENCY retire_click_to_db_removal_ms=$(($(date +%s%3N)-retire_click_ms))"
if session_alive; then echo 'Retired tmux session is still alive' >&2; exit 1; fi
[[ $(unit_field "$(identity_field pane_scope)" ActiveState) != active ]]
[[ $(unit_field "$(identity_field server_scope)" ActiveState) != active ]]
echo 'RETIRE removed widget/session and stopped exact pane scope'
stop_app
echo 'PASS real packaged session workflow'
