#!/usr/bin/env bash
# Stop only Aico's exact desktop-runtime systemd service cgroup. Durable tmux
# server and pane scopes use different units and are never inspected or touched.
set -euo pipefail

# Unit/cgroup identity must not depend on user-writable agent wrapper paths.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/aico"
PIDFILE="$LOG_DIR/aico.pid"
REPO="${AICO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
readonly RUNTIME_UNITS=(aico-shell-runtime.service aico-shell.service)

is_aico_process() {
  local pid="$1"
  local cmd cwd

  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"

  case "$cmd" in
    *"$REPO"*) return 0 ;;
  esac

  if [ "$cwd" = "$REPO" ]; then
    case "$cmd" in
      *electron*|*node*|*npm*|*bash*) return 0 ;;
    esac
  fi

  return 1
}

if ! command -v systemctl >/dev/null 2>&1; then
  echo "aico-stop: systemctl is required for exact runtime cleanup; refusing process-level fallback" >&2
  exit 1
fi

process_control_group() {
  local pid="$1"
  awk -F: '$1 == "0" && $2 == "" { print $3; exit }' "/proc/$pid/cgroup" 2>/dev/null || true
}

process_has_environment() {
  local pid="$1"
  local expected="$2"
  local entry
  [ -r "/proc/$pid/environ" ] || return 1
  while IFS= read -r -d '' entry; do
    if [ "$entry" = "$expected" ]; then return 0; fi
  done <"/proc/$pid/environ"
  return 1
}

# Electron asks the desktop to classify its window-owning process as
# app-aico-<pid>.scope. That cgroup move is not a loss of ownership when the
# same PID remains systemd's MainPID for our canonical service. Return the exact
# scope identity only after corroborating its active systemd record and direct
# cgroup membership. InvocationID prevents a same-name replacement from gaining
# cleanup authority after the canonical service is stopped.
tracked_aico_application_scope_identity() {
  local pid="$1"
  local process_control_group="$2"
  local unit="app-aico-${pid}.scope"
  local expected="/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/$unit"
  local properties load_state active_state control_group invocation_id

  [ "$process_control_group" = "$expected" ] || return 1
  properties="$(
    systemctl --user show "$unit" --no-pager \
      --property=LoadState \
      --property=ActiveState \
      --property=ControlGroup \
      --property=InvocationID 2>/dev/null
  )" || return 1
  load_state="$(awk -F= '$1 == "LoadState" { print $2; exit }' <<<"$properties")"
  active_state="$(awk -F= '$1 == "ActiveState" { print $2; exit }' <<<"$properties")"
  control_group="$(awk -F= '$1 == "ControlGroup" { print $2; exit }' <<<"$properties")"
  invocation_id="$(awk -F= '$1 == "InvocationID" { print $2; exit }' <<<"$properties")"
  [ "$load_state" = loaded ] || return 1
  case "$active_state" in active | activating | reloading | deactivating) ;; *) return 1 ;; esac
  [ "$control_group" = "$expected" ] || return 1
  [[ "$invocation_id" =~ ^[0-9a-f]{32}$ ]] || return 1
  grep -Fxq "$pid" "/sys/fs/cgroup$expected/cgroup.procs" 2>/dev/null || return 1
  printf '%s\t%s\t%s\n' "$unit" "$expected" "$invocation_id"
}

process_is_tracked_aico_application_scope() {
  tracked_aico_application_scope_identity "$1" "$2" >/dev/null
}

# A live pidfile must point to the MainPID of one of the two supported exact
# desktop units. Refuse before stopping anything if it points into a pane scope,
# an unrelated service, or a recycled process.
PID="$(cat "$PIDFILE" 2>/dev/null || true)"
LIVE_PID_UNIT=""
if [[ "$PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$PID" 2>/dev/null; then
  if ! is_aico_process "$PID"; then
    CMD="$(tr '\0' ' ' <"/proc/$PID/cmdline" 2>/dev/null || true)"
    echo "aico-stop: refusing live non-Aico pidfile target $PID: [$CMD]" >&2
    exit 1
  fi
  PID_CONTROL_GROUP="$(process_control_group "$PID")"
  for unit in "${RUNTIME_UNITS[@]}"; do
    expected="/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/$unit"
    unit_main_pid="$(
      systemctl --user show "$unit" --property=MainPID --value 2>/dev/null || true
    )"
    if [ "$PID_CONTROL_GROUP" = "$expected" ] ||
      { [ "$unit_main_pid" = "$PID" ] &&
        process_is_tracked_aico_application_scope "$PID" "$PID_CONTROL_GROUP"; }; then
      LIVE_PID_UNIT="$unit"
    fi
  done
  if [ -z "$LIVE_PID_UNIT" ]; then
    echo "aico-stop: refusing pid $PID outside an exact Aico desktop-runtime unit" >&2
    exit 1
  fi
fi

verified_units=0
stopped_units=0
unverified_units=0
for unit in "${RUNTIME_UNITS[@]}"; do
  if ! properties="$(
    systemctl --user show "$unit" --no-pager \
      --property=LoadState \
      --property=ActiveState \
      --property=MainPID \
      --property=ControlGroup \
      --property=Environment 2>/dev/null
  )"; then
    echo "aico-stop: could not query ownership for $unit; refusing partial cleanup" >&2
    exit 1
  fi
  load_state=""
  active_state=""
  main_pid=""
  control_group=""
  unit_environment=""
  while IFS= read -r line; do
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      LoadState) load_state="$value" ;;
      ActiveState) active_state="$value" ;;
      MainPID) main_pid="$value" ;;
      ControlGroup) control_group="$value" ;;
      Environment) unit_environment="$value" ;;
    esac
  done <<<"$properties"

  case "$active_state" in
    active|activating|reloading|deactivating) ;;
    failed)
      # A failed unit needs cleanup only while its exact cgroup still exists.
      [ -n "$control_group" ] && [ -e "/sys/fs/cgroup$control_group" ] || continue
      ;;
    *) continue ;;
  esac

  expected_control_group="/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/$unit"
  if [ "$load_state" != loaded ] || [ "$control_group" != "$expected_control_group" ] ||
    [[ " $unit_environment " != *" AICO_OWNER=aico "* ]] ||
    [[ " $unit_environment " != *" AICO_WORKLOAD_CLASS=desktop-runtime "* ]] ||
    [[ " $unit_environment " != *" AICO_RUNTIME_UNIT=$unit "* ]]; then
    echo "aico-stop: refusing unverified active unit $unit" >&2
    unverified_units=$((unverified_units + 1))
    continue
  fi

  # When a MainPID remains, corroborate the unit record against /proc as well as
  # the pidfile. This prevents a same-name unit or stale unit record from becoming
  # cleanup authority for another workload.
  application_scope_unit=""
  application_scope_control_group=""
  application_scope_invocation_id=""
  if [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$main_pid" 2>/dev/null; then
    main_pid_control_group="$(process_control_group "$main_pid")"
    application_scope_identity=""
    main_pid_environment_verified=0
    # Electron/Chromium clears its inherited marker environment after GNOME
    # reclassifies the window owner. Keep requiring the markers while MainPID is
    # in the service cgroup; for an exact application scope, the already-verified
    # unit environment plus MainPID/PID-derived scope/InvocationID is the proof.
    if process_has_environment "$main_pid" "AICO_OWNER=aico" &&
      process_has_environment "$main_pid" "AICO_WORKLOAD_CLASS=desktop-runtime" &&
      process_has_environment "$main_pid" "AICO_RUNTIME_UNIT=$unit"; then
      main_pid_environment_verified=1
    fi
    if [ "$main_pid_control_group" != "$control_group" ]; then
      application_scope_identity="$(
        tracked_aico_application_scope_identity "$main_pid" "$main_pid_control_group"
      )" || true
      if [ -n "$application_scope_identity" ]; then
        IFS=$'\t' read -r \
          application_scope_unit \
          application_scope_control_group \
          application_scope_invocation_id <<<"$application_scope_identity"
      fi
    fi
    if ! is_aico_process "$main_pid" ||
      { [ "$main_pid_control_group" != "$control_group" ] &&
        [ -z "$application_scope_identity" ]; } ||
      { [ -z "$application_scope_identity" ] &&
        [ "$main_pid_environment_verified" -ne 1 ]; }; then
      echo "aico-stop: refusing $unit with unverified MainPID $main_pid" >&2
      unverified_units=$((unverified_units + 1))
      continue
    fi
  elif [ "$LIVE_PID_UNIT" = "$unit" ]; then
    echo "aico-stop: refusing $unit because live pidfile $PID does not match MainPID '$main_pid'" >&2
    unverified_units=$((unverified_units + 1))
    continue
  fi

  if [ "$LIVE_PID_UNIT" = "$unit" ] && [ "$main_pid" != "$PID" ]; then
    echo "aico-stop: refusing $unit because pidfile $PID does not match MainPID $main_pid" >&2
    unverified_units=$((unverified_units + 1))
    continue
  fi

  verified_units=$((verified_units + 1))
  echo "aico-stop: stopping exact runtime unit $unit (cgroup $control_group)" >&2
  if ! systemctl --user stop "$unit"; then
    echo "aico-stop: systemd failed to stop $unit" >&2
    exit 1
  fi

  # KillMode=mixed cleans the service cgroup, but GNOME may have moved the main
  # process and helpers into its application scope. If that pre-validated exact
  # scope remains, re-check its immutable invocation identity and stop only it.
  # Never discover a cleanup target by process name or wildcard after shutdown.
  if [ -n "$application_scope_unit" ]; then
    application_scope_properties="$(
      systemctl --user show "$application_scope_unit" --no-pager \
        --property=LoadState \
        --property=ActiveState \
        --property=ControlGroup \
        --property=InvocationID 2>/dev/null || true
    )"
    application_scope_load_state="$(
      awk -F= '$1 == "LoadState" { print $2; exit }' <<<"$application_scope_properties"
    )"
    application_scope_active_state="$(
      awk -F= '$1 == "ActiveState" { print $2; exit }' <<<"$application_scope_properties"
    )"
    current_application_scope_control_group="$(
      awk -F= '$1 == "ControlGroup" { print $2; exit }' <<<"$application_scope_properties"
    )"
    current_application_scope_invocation_id="$(
      awk -F= '$1 == "InvocationID" { print $2; exit }' <<<"$application_scope_properties"
    )"
    application_scope_populated=0
    if [ -e "/sys/fs/cgroup$application_scope_control_group/cgroup.events" ] &&
      ! grep -Fxq 'populated 0' "/sys/fs/cgroup$application_scope_control_group/cgroup.events"; then
      application_scope_populated=1
    fi

    case "$application_scope_active_state" in
      active|activating|reloading|deactivating|failed) application_scope_populated=1 ;;
    esac
    if [ "$application_scope_populated" -eq 1 ]; then
      if [ "$application_scope_load_state" != loaded ] ||
        [ "$current_application_scope_control_group" != "$application_scope_control_group" ] ||
        [ "$current_application_scope_invocation_id" != "$application_scope_invocation_id" ]; then
        echo "aico-stop: refusing changed application scope $application_scope_unit" >&2
        exit 1
      fi
      echo "aico-stop: stopping exact application scope $application_scope_unit" >&2
      if ! systemctl --user stop "$application_scope_unit"; then
        echo "aico-stop: systemd failed to stop $application_scope_unit" >&2
        exit 1
      fi
    fi
    if [ -e "/sys/fs/cgroup$application_scope_control_group/cgroup.events" ] &&
      ! grep -Fxq 'populated 0' "/sys/fs/cgroup$application_scope_control_group/cgroup.events"; then
      echo "aico-stop: $application_scope_unit remains populated after stop" >&2
      exit 1
    fi
  fi
  if [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$main_pid" 2>/dev/null; then
    echo "aico-stop: $unit stopped but tracked MainPID $main_pid remains alive" >&2
    exit 1
  fi
  if [ -e "/sys/fs/cgroup$control_group/cgroup.events" ] &&
    ! grep -Fxq 'populated 0' "/sys/fs/cgroup$control_group/cgroup.events"; then
    echo "aico-stop: $unit remains populated after stop; preserving pidfile evidence" >&2
    exit 1
  fi
  stopped_units=$((stopped_units + 1))
done

if [ "$unverified_units" -ne 0 ]; then
  echo "aico-stop: one or more runtime-like units could not be proven; cleanup incomplete" >&2
  exit 1
fi
if [ -n "$LIVE_PID_UNIT" ] && [ "$verified_units" -eq 0 ]; then
  echo "aico-stop: live pidfile target was not backed by a verified runtime unit" >&2
  exit 1
fi

# Clear only the pid value inspected above; do not erase a concurrent runner's
# newer registration. The shared launch lock prevents ordinary overlap, while
# this compare protects an unexpected external rewrite.
if [ "$(cat "$PIDFILE" 2>/dev/null || true)" = "$PID" ]; then rm -f "$PIDFILE"; fi
if [ "$stopped_units" -eq 0 ]; then
  echo "aico-stop: no active verified runtime unit; cleared stale pidfile only" >&2
else
  echo "aico-stop: stopped $stopped_units exact runtime unit(s)" >&2
fi
