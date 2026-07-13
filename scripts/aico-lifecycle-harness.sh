#!/usr/bin/env bash
# Safe, host-level lifecycle regression for Aico's tmux containment contract.
#
# This harness never opens the production `aico` tmux socket. Every tmux
# command carries a generated -L name and a private TMUX_TMPDIR. Cleanup uses
# only the exact generated server service plus PIDs and pane scopes discovered
# from this run.
set -Eeuo pipefail

# A harness started from inside an attached pane must still address only its
# generated socket. Do this before any subprocess can inherit tmux routing.
unset TMUX

readonly WAIT_SECONDS="${AICO_LIFECYCLE_WAIT_SECONDS:-10}"
readonly RUN_ID="${AICO_LIFECYCLE_RUN_ID:-$(date +%s)-$$-$RANDOM}"
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$ ]]; then
  printf 'FAIL unsafe AICO_LIFECYCLE_RUN_ID: %q\n' "$RUN_ID" >&2
  exit 2
fi
readonly SOCKET="aico-lifecycle-${UID}-${RUN_ID}"
readonly RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/alh.${UID}.XXXXXX")"
readonly TMUX_STATE_DIR="$RUN_DIR/t"
readonly SOCKET_PATH="$TMUX_STATE_DIR/tmux-${UID}/$SOCKET"
readonly CREATOR_ID="$(printf '%s' "$RUN_ID" | sha256sum | cut -c1-32)"
readonly SERVER_UNIT="aico-tmux-server-${CREATOR_ID}"
readonly SERVER_SCOPE="${SERVER_UNIT}.service"
readonly SERVER_DESCRIPTION="Aico lifecycle harness tmux server ($RUN_ID)"
readonly PANE_SCOPE_RE='^tmux-spawn-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.scope$'
readonly SESSION_ONE="lifecycle-one-${RUN_ID}"
readonly SESSION_TWO="lifecycle-two-${RUN_ID}"
readonly MARKER_ONE_PARENT="aico-harness-${RUN_ID}-one-parent"
readonly MARKER_ONE_CHILD="aico-harness-${RUN_ID}-one-detached"
readonly MARKER_ONE_REPLACEMENT_PARENT="aico-harness-${RUN_ID}-one-replacement-parent"
readonly MARKER_ONE_REPLACEMENT_CHILD="aico-harness-${RUN_ID}-one-replacement-detached"
readonly MARKER_TWO_PARENT="aico-harness-${RUN_ID}-two-parent"
readonly MARKER_TWO_CHILD="aico-harness-${RUN_ID}-two-detached"

declare -a OWNED_PIDS=()
declare -a OWNED_SCOPES=()
declare -A OWNED_SCOPE_CGROUPS=()
declare -A OWNED_SCOPE_PIDS=()
declare -a ATTACH_LAUNCHERS=()
declare -a ATTACH_CLIENTS=()
SCOPE_ONE=""
SCOPE_ONE_REPLACEMENT=""
SCOPE_TWO=""
SCOPE_ONE_CONTROL_GROUP=""
SCOPE_ONE_REPLACEMENT_CONTROL_GROUP=""
SCOPE_TWO_CONTROL_GROUP=""
SERVER_CONTROL_GROUP=""
SERVER_PID=""
SERVER_SCOPE_ARMED=0
PANE_ONE_PID=""
PANE_ONE_REPLACEMENT_PID=""
PANE_TWO_PID=""
ONE_PARENT_PID=""
ONE_CHILD_PID=""
ONE_REPLACEMENT_PARENT_PID=""
ONE_REPLACEMENT_CHILD_PID=""
TWO_PARENT_PID=""
TWO_CHILD_PID=""
ATTACH_RESULT_LAUNCHER=""
ATTACH_RESULT_CLIENT=""
ATTACH_RESULT_NAME=""
CLEANUP_STARTED=0

log() {
  printf 'HARNESS %s\n' "$*"
}

pass() {
  printf 'PASS %s\n' "$*"
}

fail() {
  printf 'FAIL %s\n' "$*" >&2
  return 1
}

tmux_harness() {
  env -u TMUX TMUX_TMPDIR="$TMUX_STATE_DIR" tmux -L "$SOCKET" "$@"
}

pid_alive() {
  local pid="${1:-}"
  local state
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  state="$(awk '/^State:/ { print $2; exit }' "/proc/$pid/status" 2>/dev/null || true)"
  [[ -n "$state" && "$state" != Z && "$state" != X ]]
}

pid_cmdline() {
  local pid="$1"
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true
}

pid_has_marker() {
  local pid="$1"
  local marker="$2"
  pid_alive "$pid" && [[ "$(pid_cmdline "$pid")" == *"$marker"* ]]
}

pid_has_environment() {
  local pid="$1"
  local key="$2"
  local value="$3"
  [[ -r "/proc/$pid/environ" ]] || return 1
  tr '\0' '\n' <"/proc/$pid/environ" | grep -Fxq "$key=$value"
}

pid_scope() {
  local pid="$1"
  local line path unit
  [[ -r "/proc/$pid/cgroup" ]] || return 1
  while IFS= read -r line; do
    path="${line##*:}"
    unit="${path##*/}"
    if [[ "$unit" =~ $PANE_SCOPE_RE ]]; then
      printf '%s\n' "$unit"
      return 0
    fi
  done <"/proc/$pid/cgroup"
  return 1
}

pid_cgroup_leaf() {
  local pid="$1"
  local line path
  [[ -r "/proc/$pid/cgroup" ]] || return 1
  while IFS= read -r line; do
    path="${line##*:}"
    if [[ -n "$path" ]]; then
      printf '%s\n' "${path##*/}"
      return 0
    fi
  done <"/proc/$pid/cgroup"
  return 1
}

socket_name_is_active() {
  local path
  [[ -r /proc/net/unix ]] || return 1
  while IFS= read -r path; do
    [[ -n "$path" && "${path##*/}" == "$SOCKET" ]] && return 0
  done < <(awk 'NR > 1 && NF >= 8 { print $NF }' /proc/net/unix)
  return 1
}

server_unit_exists() {
  local load_state
  load_state="$(systemctl --user show "$SERVER_SCOPE" --property=LoadState --value 2>/dev/null || true)"
  [[ -n "$load_state" && "$load_state" != not-found ]]
}

server_scope_is_inactive_or_missing() {
  local properties load_state active_state
  properties="$(
    systemctl --user show "$SERVER_SCOPE" --property=LoadState --property=ActiveState 2>/dev/null \
      || true
  )"
  load_state="$(awk -F= '$1 == "LoadState" { print $2; exit }' <<<"$properties")"
  active_state="$(awk -F= '$1 == "ActiveState" { print $2; exit }' <<<"$properties")"
  [[ "$load_state" == not-found || "$active_state" == inactive ]]
}

unit_is_inactive_or_missing() {
  local unit="$1"
  local properties load_state active_state
  properties="$(
    systemctl --user show "$unit" --property=LoadState --property=ActiveState 2>/dev/null \
      || true
  )"
  load_state="$(awk -F= '$1 == "LoadState" { print $2; exit }' <<<"$properties")"
  active_state="$(awk -F= '$1 == "ActiveState" { print $2; exit }' <<<"$properties")"
  [[ "$load_state" == not-found || "$active_state" == inactive ]]
}

private_socket_is_inactive() {
  # tmux may leave its private socket inode behind after the exact server service
  # is empty. /proc/net/unix proves whether it is still active; cleanup later
  # removes the collision-checked private RUN_DIR and any stale inode within it.
  ! socket_name_is_active
}

scope_is_active() {
  [[ "$(systemctl --user is-active "$1" 2>/dev/null || true)" == "active" ]]
}

scope_control_group() {
  systemctl --user show "$1" --property=ControlGroup --value 2>/dev/null || true
}

control_group_contains_pid() {
  local control_group="$1"
  local expected_pid="$2"
  [[ -n "$control_group" && -r "/sys/fs/cgroup${control_group}/cgroup.procs" ]] || return 1
  grep -Fxq "$expected_pid" "/sys/fs/cgroup${control_group}/cgroup.procs"
}

scope_contains_pid() {
  local unit="$1"
  local expected_pid="$2"
  local control_group
  control_group="$(scope_control_group "$unit")"
  control_group_contains_pid "$control_group" "$expected_pid"
}

session_exists() {
  tmux_harness has-session -t "$1" 2>/dev/null
}

session_attached_count() {
  tmux_harness display-message -p -t "$1" '#{session_attached}' 2>/dev/null || printf '0\n'
}

session_is_attached() {
  [[ "$(session_attached_count "$1")" =~ ^[1-9][0-9]*$ ]]
}

session_is_detached() {
  [[ "$(session_attached_count "$1")" == 0 ]]
}

session_not_exists() {
  ! session_exists "$1"
}

pid_not_alive() {
  ! pid_alive "$1"
}

# Polling is deliberately bounded: a failed cgroup migration or a wedged local
# client must fail the harness and enter its exact-ownership cleanup trap rather
# than leave this regression test running indefinitely.
wait_until() {
  local description="$1"
  shift
  local deadline=$((SECONDS + WAIT_SECONDS))
  while (( SECONDS < deadline )); do
    if "$@"; then return 0; fi
    sleep 0.05
  done
  fail "timeout waiting for $description"
}

read_pid_file() {
  local path="$1"
  local value
  value="$(cat "$path" 2>/dev/null || true)"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$value"
}

record_scope() {
  local pane_pid="$1"
  local scope
  scope="$(pid_scope "$pane_pid")" || return 1
  scope_is_active "$scope" || return 1
  scope_contains_pid "$scope" "$pane_pid" || return 1
  printf '%s\n' "$scope"
}

pane_has_active_scope() {
  local pane_pid="$1"
  local scope
  scope="$(pid_scope "$pane_pid")" || return 1
  scope_is_active "$scope" && scope_contains_pid "$scope" "$pane_pid"
}

write_worker() {
  local name="$1"
  local parent_marker="$2"
  local child_marker="$3"
  local worker="$RUN_DIR/worker-${name}.sh"
  cat >"$worker" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "\$\$" >'$RUN_DIR/${name}.parent.pid'
setsid bash -c 'printf "%s\\n" "\$\$" >"\$1"; exec -a "\$2" sleep 600' \\
  aico-harness-detached '$RUN_DIR/${name}.child.pid' '$child_marker' \\
  </dev/null >'$RUN_DIR/${name}.child.log' 2>&1 &
exec -a '$parent_marker' sleep 600
EOF
  chmod 700 "$worker"
  printf '%s\n' "$worker"
}

launch_worker_in_pane() {
  local session="$1"
  local worker="$2"
  # Literal send and Enter are separate tmux commands, matching Aico's repaired
  # bare-pane-then-launch ordering without allowing tmux key-name parsing.
  tmux_harness send-keys -t "$session" -l "exec '$worker'"
  tmux_harness send-keys -t "$session" Enter
}

respawn_bare_pane() {
  local session="$1"
  tmux_harness respawn-pane -k -c "$RUN_DIR" -t "$session" \
    -e "AICO_HARNESS_RUN_ID=$RUN_ID" \
    -e "AICO_SESSION_ID=$session" \
    -e AICO_WORKLOAD_CLASS=durable-session
}

start_private_tmux_server() {
  local session="$1"

  # Arm cleanup before systemd-run: if the tmux client succeeds but its caller
  # is interrupted before returning, this unique unit is still ours to stop.
  SERVER_SCOPE_ARMED=1
  env -u TMUX systemd-run \
    --user \
    --quiet \
    --collect \
    --unit="$SERVER_SCOPE" \
    --slice=app.slice \
    --description="$SERVER_DESCRIPTION" \
    --service-type=exec \
    --expand-environment=no \
    --property=ExitType=cgroup \
    --property=StandardInput=null \
    --property=StandardOutput=journal \
    --property=StandardError=journal \
    --property=CPUAccounting=yes \
    --property=MemoryAccounting=yes \
    --property=TasksAccounting=yes \
    --setenv=AICO_OWNER=aico \
    --setenv=AICO_WORKLOAD_CLASS=durable-tmux-server \
    --setenv="TMUX_TMPDIR=$TMUX_STATE_DIR" \
    -- \
    env -u TMUX TMUX_TMPDIR="$TMUX_STATE_DIR" tmux -L "$SOCKET" \
      -f /dev/null new-session -d -s "$session" -x 80 -y 24 -c "$RUN_DIR" \
      -e "AICO_HARNESS_RUN_ID=$RUN_ID" \
      -e "AICO_SESSION_ID=$session" \
      -e AICO_WORKLOAD_CLASS=durable-session

  wait_until "private tmux socket creation" test -S "$SOCKET_PATH"
  wait_until "private tmux server service registration" scope_is_active "$SERVER_SCOPE"
  SERVER_PID="$(tmux_harness display-message -p -t "$session" '#{pid}')"
  [[ "$SERVER_PID" =~ ^[0-9]+$ ]] || fail "invalid private tmux server PID"
  [[ "$(pid_cmdline "$SERVER_PID")" == *"$SOCKET"* ]] \
    || fail "private server PID $SERVER_PID does not name generated socket"
  [[ "$(pid_cgroup_leaf "$SERVER_PID")" == "$SERVER_SCOPE" ]] \
    || fail "private server PID $SERVER_PID is not in $SERVER_SCOPE"
  SERVER_CONTROL_GROUP="$(scope_control_group "$SERVER_SCOPE")"
  [[ -n "$SERVER_CONTROL_GROUP" ]] || fail "missing control group for $SERVER_SCOPE"
  control_group_contains_pid "$SERVER_CONTROL_GROUP" "$SERVER_PID" \
    || fail "$SERVER_SCOPE does not contain private server PID $SERVER_PID"
}

start_attach_client() {
  local session="$1"
  local mode="$2"
  local attach_script="$RUN_DIR/attach-${mode}.sh"
  local log_file="$RUN_DIR/attach-${mode}.log"
  cat >"$attach_script" <<EOF
#!/usr/bin/env bash
unset TMUX
export TERM=xterm-256color
exec env -u TMUX TMUX_TMPDIR='$TMUX_STATE_DIR' tmux -L '$SOCKET' attach-session -t '$session'
EOF
  chmod 700 "$attach_script"
  setsid script -qefc "$attach_script" /dev/null >"$log_file" 2>&1 &
  local launcher_pid=$!
  ATTACH_LAUNCHERS+=("$launcher_pid")
  OWNED_PIDS+=("$launcher_pid")
  wait_until "$mode attach" session_is_attached "$session"

  local client_pid
  local client_name
  IFS='|' read -r client_pid client_name < <(
    tmux_harness list-clients -F '#{client_pid}|#{session_name}|#{client_name}' \
      | awk -F '|' -v target="$session" '$2 == target { print $1 "|" $3; exit }'
  )
  [[ "$client_pid" =~ ^[0-9]+$ ]] || fail "could not resolve $mode tmux client PID"
  [[ -n "$client_name" ]] || fail "could not resolve $mode tmux client name"
  [[ "$(pid_cmdline "$client_pid")" == *"$SOCKET"* ]] \
    || fail "refusing unverified attach client PID $client_pid"
  ATTACH_CLIENTS+=("$client_pid")
  OWNED_PIDS+=("$client_pid")
  ATTACH_RESULT_LAUNCHER="$launcher_pid"
  ATTACH_RESULT_CLIENT="$client_pid"
  ATTACH_RESULT_NAME="$client_name"
}

stop_owned_scope() {
  local unit="$1"
  local expected_pid="$2"
  local expected_control_group="$3"
  local current_control_group
  if [[ ! "$unit" =~ $PANE_SCOPE_RE ]]; then
    fail "refusing non-pane scope: $unit" || true
    return 1
  fi
  if scope_is_active "$unit"; then
    current_control_group="$(scope_control_group "$unit")"
    if [[ -z "$expected_control_group" || "$current_control_group" != "$expected_control_group" ]]; then
      fail "refusing scope $unit: control group identity changed" || true
      return 1
    fi
    if ! control_group_contains_pid "$current_control_group" "$expected_pid"; then
      fail "refusing scope $unit: it no longer contains expected PID $expected_pid" || true
      return 1
    fi
    if ! systemctl --user stop "$unit"; then
      fail "failed to stop exact pane scope $unit" || true
      return 1
    fi
  fi
  if ! wait_until "$unit to become inactive or disappear" unit_is_inactive_or_missing "$unit"; then
    return 1
  fi
}

stop_owned_server_scope() {
  local properties load_state active_state current_control_group description
  if [[ ! "$SERVER_SCOPE" =~ ^aico-tmux-server-[0-9a-f]{32}\.service$ ]]; then
    fail "refusing unsafe server service: $SERVER_SCOPE" || true
    return 1
  fi

  properties="$(
    systemctl --user show "$SERVER_SCOPE" \
      --property=LoadState \
      --property=ActiveState \
      --property=Description \
      --property=ControlGroup \
      2>/dev/null || true
  )"
  load_state="$(awk -F= '$1 == "LoadState" { print $2; exit }' <<<"$properties")"
  active_state="$(awk -F= '$1 == "ActiveState" { print $2; exit }' <<<"$properties")"
  description="$(awk -F= '$1 == "Description" { sub(/^[^=]*=/, ""); print; exit }' <<<"$properties")"
  current_control_group="$(awk -F= '$1 == "ControlGroup" { sub(/^[^=]*=/, ""); print; exit }' <<<"$properties")"

  if [[ -z "$load_state" ]]; then
    fail "cannot determine state for server service $SERVER_SCOPE" || true
    return 1
  fi
  if [[ "$load_state" != not-found ]]; then
    if [[ "$description" != "$SERVER_DESCRIPTION" ]]; then
      fail "refusing server service $SERVER_SCOPE: description identity changed" || true
      return 1
    fi
    if [[ -n "$SERVER_CONTROL_GROUP" && -n "$current_control_group" \
      && "$current_control_group" != "$SERVER_CONTROL_GROUP" ]]; then
      fail "refusing server service $SERVER_SCOPE: control group identity changed" || true
      return 1
    fi
    if pid_alive "$SERVER_PID"; then
      if [[ "$(pid_cmdline "$SERVER_PID")" != *"$SOCKET"* ]]; then
        fail "refusing server PID $SERVER_PID: generated socket marker missing" || true
        return 1
      fi
      if ! control_group_contains_pid "$current_control_group" "$SERVER_PID"; then
        fail "refusing server service $SERVER_SCOPE: expected PID is outside it" || true
        return 1
      fi
    fi
    if ! systemctl --user stop "$SERVER_SCOPE"; then
      fail "failed to stop exact server service $SERVER_SCOPE (state=$active_state)" || true
      return 1
    fi
  fi
  if ! wait_until "$SERVER_SCOPE to become inactive or disappear" server_scope_is_inactive_or_missing; then
    return 1
  fi
  if ! wait_until "private tmux socket to become inactive" private_socket_is_inactive; then
    return 1
  fi
}

discover_private_pane_scopes_for_cleanup() {
  local pane_pid unit control_group
  [[ -S "$SOCKET_PATH" ]] || return 0
  while IFS= read -r pane_pid; do
    [[ "$pane_pid" =~ ^[0-9]+$ ]] || continue
    unit="$(pid_scope "$pane_pid" 2>/dev/null || true)"
    [[ "$unit" =~ $PANE_SCOPE_RE ]] || continue
    control_group="$(scope_control_group "$unit")"
    control_group_contains_pid "$control_group" "$pane_pid" || continue
    OWNED_SCOPES+=("$unit")
    OWNED_SCOPE_CGROUPS["$unit"]="$control_group"
    OWNED_SCOPE_PIDS["$unit"]="$pane_pid"
  done < <(tmux_harness list-panes -a -F '#{pane_pid}' 2>/dev/null || true)
}

cleanup() {
  local status=$?
  local cleanup_safe=1
  (( CLEANUP_STARTED == 0 )) || return "$status"
  CLEANUP_STARTED=1
  set +e

  # Attachment helpers are never durable. Validate their unique command line
  # before using exact PIDs, guarding against PID reuse in an abnormal long run.
  local pid cmd unit expected_control_group expected_pid current_control_group
  local properties load_state active_state
  for pid in "${ATTACH_CLIENTS[@]}" "${ATTACH_LAUNCHERS[@]}"; do
    if pid_alive "$pid"; then
      cmd="$(pid_cmdline "$pid")"
      if [[ "$cmd" == *"$SOCKET"* || "$cmd" == *"$RUN_DIR"* ]]; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
    fi
  done

  # Cover interruption immediately after first-session creation, before main
  # has recorded the pane. Discovery is read-only and can address only the
  # collision-checked private socket.
  discover_private_pane_scopes_for_cleanup

  # Stop only the exact pane scopes recorded from this run. A disappeared scope
  # is already clean; broad app/session/user scopes can never enter this array.
  for unit in "${OWNED_SCOPES[@]}"; do
    if [[ "$unit" =~ $PANE_SCOPE_RE ]]; then
      expected_control_group="${OWNED_SCOPE_CGROUPS[$unit]:-}"
      expected_pid="${OWNED_SCOPE_PIDS[$unit]:-}"
      properties="$(
        systemctl --user show "$unit" \
          --property=LoadState \
          --property=ActiveState \
          --property=ControlGroup \
          2>/dev/null || true
      )"
      load_state="$(awk -F= '$1 == "LoadState" { print $2; exit }' <<<"$properties")"
      active_state="$(awk -F= '$1 == "ActiveState" { print $2; exit }' <<<"$properties")"
      current_control_group="$(
        awk -F= '$1 == "ControlGroup" { sub(/^[^=]*=/, ""); print; exit }' <<<"$properties"
      )"
      if [[ "$load_state" == not-found || "$active_state" == inactive ]]; then
        continue
      fi
      if [[ -z "$load_state" || -z "$expected_control_group" \
        || "$current_control_group" != "$expected_control_group" ]]; then
        cleanup_safe=0
        printf 'FAIL refusing pane cleanup for %s: control-group identity is unproven\n' "$unit" >&2
        continue
      fi
      if pid_alive "$expected_pid" \
        && ! control_group_contains_pid "$current_control_group" "$expected_pid"; then
        cleanup_safe=0
        printf 'FAIL refusing pane cleanup for %s: expected PID %s is outside it\n' \
          "$unit" "$expected_pid" >&2
        continue
      fi
      if ! systemctl --user stop "$unit"; then
        cleanup_safe=0
        printf 'FAIL could not stop exact pane scope %s\n' "$unit" >&2
        continue
      fi
      if ! wait_until "$unit to become inactive or disappear" unit_is_inactive_or_missing "$unit"; then
        cleanup_safe=0
      fi
    fi
  done

  # Stop only the collision-checked private server unit. Never issue even a
  # qualified kill-server here: the service is the ownership proof and boundary.
  if (( SERVER_SCOPE_ARMED == 1 )); then
    if ! stop_owned_server_scope; then
      cleanup_safe=0
      printf 'FAIL exact server cleanup could not be proven; retaining %s for diagnosis\n' "$RUN_DIR" >&2
    fi
  fi
  if (( cleanup_safe == 1 )); then
    rm -rf -- "$RUN_DIR"
  else
    printf 'FAIL cleanup proof incomplete; retaining %s for diagnosis\n' "$RUN_DIR" >&2
  fi
  if (( status == 0 && cleanup_safe == 0 )); then return 1; fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

main() {
  [[ "$SOCKET" == aico-lifecycle-* && "$SOCKET" != aico && "$SOCKET" != default ]] \
    || fail "unsafe tmux socket name: $SOCKET"
  [[ "$SOCKET" =~ ^[A-Za-z0-9._-]+$ ]] || fail "unsafe characters in socket name: $SOCKET"
  [[ "$WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "AICO_LIFECYCLE_WAIT_SECONDS must be positive"
  for command in tmux systemctl systemd-run script setsid awk grep find sha256sum cut; do
    command -v "$command" >/dev/null || fail "missing required command: $command"
  done
  systemctl --user show-environment >/dev/null \
    || fail "systemd user manager unavailable; this is a host integration harness"
  [[ -r /proc/net/unix ]] || fail "cannot prove Unix socket-name isolation"
  [[ -r /sys/fs/cgroup/cgroup.controllers ]] || fail "cgroup v2 is required"
  mkdir -p "$TMUX_STATE_DIR"
  chmod 700 "$TMUX_STATE_DIR"
  (( ${#SOCKET_PATH} < 100 )) || fail "private socket path is too long: $SOCKET_PATH"
  [[ ! -e "$SOCKET_PATH" && ! -S "$SOCKET_PATH" ]] \
    || fail "refusing pre-existing private socket path: $SOCKET_PATH"
  socket_name_is_active && fail "refusing active Unix socket name collision: $SOCKET"
  local colliding_socket
  colliding_socket="$(find "${TMPDIR:-/tmp}" -xdev -type s -name "$SOCKET" -print -quit 2>/dev/null || true)"
  [[ -z "$colliding_socket" ]] || fail "refusing existing socket name collision: $colliding_socket"
  server_unit_exists && fail "refusing pre-existing server unit: $SERVER_SCOPE"

  log "run_id=$RUN_ID socket=$SOCKET socket_path=$SOCKET_PATH server_service=$SERVER_SCOPE"
  pass "generated socket and server unit are collision-free (aico/default never referenced)"

  local worker_one worker_one_replacement worker_two
  worker_one="$(write_worker one "$MARKER_ONE_PARENT" "$MARKER_ONE_CHILD")"
  worker_one_replacement="$(
    write_worker one-replacement "$MARKER_ONE_REPLACEMENT_PARENT" "$MARKER_ONE_REPLACEMENT_CHILD"
  )"
  worker_two="$(write_worker two "$MARKER_TWO_PARENT" "$MARKER_TWO_CHILD")"

  # The first bare session starts the private tmux server inside the same
  # durable systemd service pattern used by Aico. Every pane is subsequently
  # moved by tmux into a narrower tmux-spawn scope before any worker launches.
  start_private_tmux_server "$SESSION_ONE"
  scope_is_active "$SERVER_SCOPE" || fail "private server service is not active"
  pass "private tmux server PID $SERVER_PID is owned by exact service $SERVER_SCOPE"

  tmux_harness new-session -d -s "$SESSION_TWO" -x 80 -y 24 -c "$RUN_DIR" \
    -e "AICO_HARNESS_RUN_ID=$RUN_ID" \
    -e "AICO_SESSION_ID=$SESSION_TWO" \
    -e AICO_WORKLOAD_CLASS=durable-session
  PANE_ONE_PID="$(tmux_harness display-message -p -t "$SESSION_ONE" '#{pane_pid}')"
  PANE_TWO_PID="$(tmux_harness display-message -p -t "$SESSION_TWO" '#{pane_pid}')"
  [[ "$PANE_ONE_PID" =~ ^[0-9]+$ && "$PANE_TWO_PID" =~ ^[0-9]+$ ]] \
    || fail "invalid pane PIDs"
  wait_until "session one pane scope" pane_has_active_scope "$PANE_ONE_PID"
  wait_until "session two pane scope" pane_has_active_scope "$PANE_TWO_PID"
  SCOPE_ONE="$(record_scope "$PANE_ONE_PID")"
  SCOPE_TWO="$(record_scope "$PANE_TWO_PID")"
  SCOPE_ONE_CONTROL_GROUP="$(scope_control_group "$SCOPE_ONE")"
  SCOPE_TWO_CONTROL_GROUP="$(scope_control_group "$SCOPE_TWO")"
  OWNED_SCOPES+=("$SCOPE_ONE" "$SCOPE_TWO")
  OWNED_SCOPE_CGROUPS["$SCOPE_ONE"]="$SCOPE_ONE_CONTROL_GROUP"
  OWNED_SCOPE_CGROUPS["$SCOPE_TWO"]="$SCOPE_TWO_CONTROL_GROUP"
  OWNED_SCOPE_PIDS["$SCOPE_ONE"]="$PANE_ONE_PID"
  OWNED_SCOPE_PIDS["$SCOPE_TWO"]="$PANE_TWO_PID"
  OWNED_PIDS+=("$SERVER_PID" "$PANE_ONE_PID" "$PANE_TWO_PID")
  [[ "$SCOPE_ONE" != "$SCOPE_TWO" ]] || fail "two panes share one scope: $SCOPE_ONE"
  [[ "$SCOPE_ONE" != "$SERVER_SCOPE" && "$SCOPE_TWO" != "$SERVER_SCOPE" ]] \
    || fail "pane workload shares the durable tmux-server service"
  pass "bare panes received distinct scopes ($SCOPE_ONE, $SCOPE_TWO)"

  launch_worker_in_pane "$SESSION_ONE" "$worker_one"
  launch_worker_in_pane "$SESSION_TWO" "$worker_two"
  wait_until "session one PID files" test -s "$RUN_DIR/one.child.pid"
  wait_until "session two PID files" test -s "$RUN_DIR/two.child.pid"
  ONE_PARENT_PID="$(read_pid_file "$RUN_DIR/one.parent.pid")"
  ONE_CHILD_PID="$(read_pid_file "$RUN_DIR/one.child.pid")"
  TWO_PARENT_PID="$(read_pid_file "$RUN_DIR/two.parent.pid")"
  TWO_CHILD_PID="$(read_pid_file "$RUN_DIR/two.child.pid")"
  OWNED_PIDS+=("$ONE_PARENT_PID" "$ONE_CHILD_PID" "$TWO_PARENT_PID" "$TWO_CHILD_PID")
  OWNED_SCOPE_PIDS["$SCOPE_ONE"]="$ONE_CHILD_PID"
  OWNED_SCOPE_PIDS["$SCOPE_TWO"]="$TWO_CHILD_PID"

  pid_has_marker "$ONE_PARENT_PID" "$MARKER_ONE_PARENT" || fail "session one parent marker missing"
  pid_has_marker "$ONE_CHILD_PID" "$MARKER_ONE_CHILD" || fail "session one child marker missing"
  pid_has_marker "$TWO_PARENT_PID" "$MARKER_TWO_PARENT" || fail "session two parent marker missing"
  pid_has_marker "$TWO_CHILD_PID" "$MARKER_TWO_CHILD" || fail "session two child marker missing"
  [[ "$(pid_scope "$ONE_PARENT_PID")" == "$SCOPE_ONE" ]] || fail "session one parent escaped"
  [[ "$(pid_scope "$ONE_CHILD_PID")" == "$SCOPE_ONE" ]] || fail "detached child escaped session one"
  [[ "$(pid_scope "$TWO_PARENT_PID")" == "$SCOPE_TWO" ]] || fail "session two parent escaped"
  [[ "$(pid_scope "$TWO_CHILD_PID")" == "$SCOPE_TWO" ]] || fail "detached child escaped session two"
  for pid in "$ONE_PARENT_PID" "$ONE_CHILD_PID"; do
    pid_has_environment "$pid" AICO_WORKLOAD_CLASS durable-session \
      || fail "session one worker $pid missed workload-class ownership"
    pid_has_environment "$pid" AICO_SESSION_ID "$SESSION_ONE" \
      || fail "session one worker $pid missed session ownership"
  done
  for pid in "$TWO_PARENT_PID" "$TWO_CHILD_PID"; do
    pid_has_environment "$pid" AICO_WORKLOAD_CLASS durable-session \
      || fail "session two worker $pid missed workload-class ownership"
    pid_has_environment "$pid" AICO_SESSION_ID "$SESSION_TWO" \
      || fail "session two worker $pid missed session ownership"
  done
  pass "setsid children stayed contained and inherited workload/session ownership"

  # Simulate the Aico/node-pty attachment dying unexpectedly. Only the exact
  # tmux client is killed; the durable tmux session and workload must survive.
  local crash_launcher crash_client
  start_attach_client "$SESSION_TWO" crash
  crash_launcher="$ATTACH_RESULT_LAUNCHER"
  crash_client="$ATTACH_RESULT_CLIENT"
  kill -KILL "$crash_client"
  wait_until "crashed attach client to exit" pid_not_alive "$crash_client"
  wait_until "session to detach after client crash" session_is_detached "$SESSION_TWO"
  session_exists "$SESSION_TWO" || fail "durable session died with attach client"
  pid_has_marker "$TWO_CHILD_PID" "$MARKER_TWO_CHILD" || fail "workload died with attach client"
  wait "$crash_launcher" 2>/dev/null || true
  pass "attach-client crash preserved the durable session and detached child"

  # Reconnect through a real tmux client, then ask tmux to detach it cleanly.
  local reconnect_launcher reconnect_client reconnect_name
  start_attach_client "$SESSION_TWO" reconnect
  reconnect_launcher="$ATTACH_RESULT_LAUNCHER"
  reconnect_client="$ATTACH_RESULT_CLIENT"
  reconnect_name="$ATTACH_RESULT_NAME"
  tmux_harness detach-client -t "$reconnect_name"
  wait_until "reconnect client to detach" pid_not_alive "$reconnect_client"
  wait "$reconnect_launcher" 2>/dev/null || true
  session_exists "$SESSION_TWO" || fail "session died after reconnect/detach"
  pass "real tmux reconnect and clean detach succeeded"

  # Match Aico's Replace TUI path: respawn the pane bare, require a new scope,
  # launch the replacement only after migration, then retire only the old scope.
  respawn_bare_pane "$SESSION_ONE"
  wait_until "old pane parent to exit on respawn" pid_not_alive "$ONE_PARENT_PID"
  pid_has_marker "$ONE_CHILD_PID" "$MARKER_ONE_CHILD" \
    || fail "old detached child did not survive long enough to prove replacement cleanup"
  [[ "$(pid_scope "$ONE_CHILD_PID")" == "$SCOPE_ONE" ]] \
    || fail "old detached child moved out of its recorded scope"

  PANE_ONE_REPLACEMENT_PID="$(tmux_harness display-message -p -t "$SESSION_ONE" '#{pane_pid}')"
  [[ "$PANE_ONE_REPLACEMENT_PID" =~ ^[0-9]+$ ]] || fail "invalid replacement pane PID"
  wait_until "replacement pane scope" pane_has_active_scope "$PANE_ONE_REPLACEMENT_PID"
  SCOPE_ONE_REPLACEMENT="$(record_scope "$PANE_ONE_REPLACEMENT_PID")"
  [[ "$SCOPE_ONE_REPLACEMENT" != "$SCOPE_ONE" ]] \
    || fail "tmux reused old pane scope during respawn: $SCOPE_ONE"
  [[ "$SCOPE_ONE_REPLACEMENT" != "$SCOPE_TWO" && "$SCOPE_ONE_REPLACEMENT" != "$SERVER_SCOPE" ]] \
    || fail "replacement pane scope is not isolated: $SCOPE_ONE_REPLACEMENT"
  SCOPE_ONE_REPLACEMENT_CONTROL_GROUP="$(scope_control_group "$SCOPE_ONE_REPLACEMENT")"
  OWNED_SCOPES+=("$SCOPE_ONE_REPLACEMENT")
  OWNED_SCOPE_CGROUPS["$SCOPE_ONE_REPLACEMENT"]="$SCOPE_ONE_REPLACEMENT_CONTROL_GROUP"
  OWNED_SCOPE_PIDS["$SCOPE_ONE_REPLACEMENT"]="$PANE_ONE_REPLACEMENT_PID"
  OWNED_PIDS+=("$PANE_ONE_REPLACEMENT_PID")

  launch_worker_in_pane "$SESSION_ONE" "$worker_one_replacement"
  wait_until "replacement PID files" test -s "$RUN_DIR/one-replacement.child.pid"
  ONE_REPLACEMENT_PARENT_PID="$(read_pid_file "$RUN_DIR/one-replacement.parent.pid")"
  ONE_REPLACEMENT_CHILD_PID="$(read_pid_file "$RUN_DIR/one-replacement.child.pid")"
  OWNED_PIDS+=("$ONE_REPLACEMENT_PARENT_PID" "$ONE_REPLACEMENT_CHILD_PID")
  OWNED_SCOPE_PIDS["$SCOPE_ONE_REPLACEMENT"]="$ONE_REPLACEMENT_CHILD_PID"
  pid_has_marker "$ONE_REPLACEMENT_PARENT_PID" "$MARKER_ONE_REPLACEMENT_PARENT" \
    || fail "replacement parent marker missing"
  pid_has_marker "$ONE_REPLACEMENT_CHILD_PID" "$MARKER_ONE_REPLACEMENT_CHILD" \
    || fail "replacement child marker missing"
  [[ "$(pid_scope "$ONE_REPLACEMENT_PARENT_PID")" == "$SCOPE_ONE_REPLACEMENT" ]] \
    || fail "replacement parent escaped its new scope"
  [[ "$(pid_scope "$ONE_REPLACEMENT_CHILD_PID")" == "$SCOPE_ONE_REPLACEMENT" ]] \
    || fail "replacement detached child escaped its new scope"
  for pid in "$ONE_REPLACEMENT_PARENT_PID" "$ONE_REPLACEMENT_CHILD_PID"; do
    pid_has_environment "$pid" AICO_WORKLOAD_CLASS durable-session \
      || fail "replacement worker $pid missed workload-class ownership"
    pid_has_environment "$pid" AICO_SESSION_ID "$SESSION_ONE" \
      || fail "replacement worker $pid missed session ownership"
  done

  stop_owned_scope "$SCOPE_ONE" "$ONE_CHILD_PID" "$SCOPE_ONE_CONTROL_GROUP"
  wait_until "old detached child cleanup" pid_not_alive "$ONE_CHILD_PID"
  pid_has_marker "$ONE_REPLACEMENT_CHILD_PID" "$MARKER_ONE_REPLACEMENT_CHILD" \
    || fail "old-scope cleanup killed replacement child"
  pid_has_marker "$TWO_CHILD_PID" "$MARKER_TWO_CHILD" \
    || fail "old-scope cleanup killed peer-session child"
  session_exists "$SESSION_ONE" || fail "old-scope cleanup killed replacement session"
  session_exists "$SESSION_TWO" || fail "old-scope cleanup killed peer session"
  pass "respawn created a new scope; old-scope cleanup preserved replacement and peer"

  # Simulate an unexpected pane-parent crash. The setsid child remains in the
  # recorded scope until exact whole-scope reconciliation removes it.
  pid_has_marker "$ONE_REPLACEMENT_PARENT_PID" "$MARKER_ONE_REPLACEMENT_PARENT" \
    || fail "refusing to crash unverified replacement parent"
  control_group_contains_pid \
    "$SCOPE_ONE_REPLACEMENT_CONTROL_GROUP" \
    "$ONE_REPLACEMENT_PARENT_PID" \
    || fail "refusing to crash replacement parent outside its recorded scope"
  kill -KILL "$ONE_REPLACEMENT_PARENT_PID"
  wait_until "replacement parent crash" pid_not_alive "$ONE_REPLACEMENT_PARENT_PID"
  wait_until "crashed pane session removal" session_not_exists "$SESSION_ONE"
  pid_has_marker "$ONE_REPLACEMENT_CHILD_PID" "$MARKER_ONE_REPLACEMENT_CHILD" \
    || fail "detached child vanished before parent-crash reconciliation"
  [[ "$(pid_scope "$ONE_REPLACEMENT_CHILD_PID")" == "$SCOPE_ONE_REPLACEMENT" ]] \
    || fail "detached child escaped after parent crash"
  session_exists "$SESSION_TWO" || fail "parent crash disturbed peer session"
  stop_owned_scope \
    "$SCOPE_ONE_REPLACEMENT" \
    "$ONE_REPLACEMENT_CHILD_PID" \
    "$SCOPE_ONE_REPLACEMENT_CONTROL_GROUP"
  wait_until "parent-crash detached child cleanup" pid_not_alive "$ONE_REPLACEMENT_CHILD_PID"
  session_exists "$SESSION_TWO" || fail "parent-crash cleanup disturbed peer session"
  pass "parent crash left an attributable child that exact-scope cleanup removed safely"

  stop_owned_scope "$SCOPE_TWO" "$TWO_CHILD_PID" "$SCOPE_TWO_CONTROL_GROUP"
  wait_until "session two parent cleanup" pid_not_alive "$TWO_PARENT_PID"
  wait_until "session two detached cleanup" pid_not_alive "$TWO_CHILD_PID"
  wait_until "session two removal" session_not_exists "$SESSION_TWO"
  stop_owned_server_scope
  SERVER_SCOPE_ARMED=0
  wait_until "private tmux socket to become inactive" private_socket_is_inactive

  for pid in "${OWNED_PIDS[@]}"; do
    pid_alive "$pid" && fail "residual workload PID $pid"
  done
  scope_is_active "$SCOPE_ONE" && fail "residual scope $SCOPE_ONE"
  scope_is_active "$SCOPE_ONE_REPLACEMENT" && fail "residual scope $SCOPE_ONE_REPLACEMENT"
  scope_is_active "$SCOPE_TWO" && fail "residual scope $SCOPE_TWO"
  scope_is_active "$SERVER_SCOPE" && fail "residual server service $SERVER_SCOPE"
  socket_name_is_active && fail "residual active Unix socket $SOCKET"
  pass "no workload PID, scope, session, or isolated tmux-server residue remains"
  printf 'RESULT passed=true run_id=%s scopes=3 sessions=2 detached_children=3 residue=0\n' "$RUN_ID"
}

main "$@"
