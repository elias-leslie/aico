#!/usr/bin/env bash
set -euo pipefail

ANDROID_LAUNCHER="${ANDROID_EMULATOR_LAUNCHER:-$HOME/bin/start-aterm-android-emulator}"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
AVD_NAME="${ANDROID_AVD_NAME:-Pixel_8_API_latest}"
CDP_PORT="${MOBILE_CDP_PORT:-9222}"
ATERM_URL="${ATERM_MOBILE_URL:-http://10.0.2.2:3002}"
BOOT_TIMEOUT_SECONDS="${MOBILE_BOOT_TIMEOUT_SECONDS:-180}"
HEADLESS_MODE="${MOBILE_EMULATOR_HEADLESS:-1}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [args]

Commands:
  doctor           Check emulator, adb, and agent-browser prerequisites
  start-emulator   Launch the Android emulator in the background
  wait-boot        Wait for adb=device and sys.boot_completed=1
  forward-cdp      Forward Android Chrome DevTools to localhost:${CDP_PORT}
  open-app         Open A-Term in Android Chrome at ${ATERM_URL}
  browser [args]   Launch agent-browser attached to forwarded CDP
  workflow         Run doctor, forward-cdp, and open-app

Environment overrides:
  ANDROID_EMULATOR_LAUNCHER  Path to emulator launcher
  ANDROID_SDK_ROOT           Android SDK root
  ANDROID_AVD_NAME           Emulator AVD name
  MOBILE_CDP_PORT            Local forwarded CDP port
  ATERM_MOBILE_URL        URL to open inside the emulator
  MOBILE_BOOT_TIMEOUT_SECONDS Seconds to wait for boot completion
  MOBILE_EMULATOR_HEADLESS   1 for headless emulator, 0 for windowed
EOF
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

check_optional_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "OK   $cmd"
  else
    echo "MISS $cmd"
  fi
}

get_window_dump() {
  adb shell uiautomator dump /sdcard/window_dump.xml >/dev/null
  adb shell cat /sdcard/window_dump.xml
}

tap_first_matching_node() {
  local xml="$1"
  shift

  local pattern
  for pattern in "$@"; do
    local node
    node="$(
      printf '%s' "${xml}" \
        | awk '{gsub(/</, "\n<"); print}' \
        | grep -F "${pattern}" \
        | head -n1
    )"
    if [[ -z "${node}" ]]; then
      continue
    fi

    local bounds
    bounds="$(printf '%s\n' "${node}" | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p')"
    if [[ -z "${bounds}" ]]; then
      continue
    fi

    read -r x1 y1 x2 y2 <<<"${bounds}"
    local x=$(((x1 + x2) / 2))
    local y=$(((y1 + y2) / 2))
    adb shell input tap "${x}" "${y}" >/dev/null
    return 0
  done

  return 1
}

doctor() {
  echo "Checking mobile verification prerequisites..."
  check_optional_cmd adb
  check_optional_cmd agent-browser
  check_optional_cmd sg

  if [[ -x "$ANDROID_LAUNCHER" ]]; then
    echo "OK   emulator launcher: $ANDROID_LAUNCHER"
  else
    echo "MISS emulator launcher: $ANDROID_LAUNCHER"
  fi

  if [[ -x "${ANDROID_SDK_ROOT}/emulator/emulator" ]]; then
    echo "OK   emulator binary: ${ANDROID_SDK_ROOT}/emulator/emulator"
  else
    echo "MISS emulator binary: ${ANDROID_SDK_ROOT}/emulator/emulator"
  fi

  if command -v adb >/dev/null 2>&1; then
    echo
    adb devices
  fi
}

_base_emulator_cmd() {
  local emulator_bin="${ANDROID_SDK_ROOT}/emulator/emulator"
  _EMU_CMD=(
    "${emulator_bin}"
    -avd "${AVD_NAME}"
    -gpu swiftshader_indirect
    -no-boot-anim
    -no-metrics
  )

  if [[ "${HEADLESS_MODE}" == "1" ]]; then
    _EMU_CMD+=(-no-window -no-audio)
  fi
}

build_emulator_command() {
  _base_emulator_cmd

  if command -v sg >/dev/null 2>&1 && getent group kvm | grep -Eq "(^|:|,)${USER}(,|$)"; then
    printf "sg kvm -c '%q" "${_EMU_CMD[0]}"
    local arg
    for arg in "${_EMU_CMD[@]:1}"; do
      printf " %q" "${arg}"
    done
    printf "'"
    return
  fi

  printf "%q" "${_EMU_CMD[0]}"
  local arg
  for arg in "${_EMU_CMD[@]:1}"; do
    printf " %q" "${arg}"
  done
}

launch_emulator_detached() {
  _base_emulator_cmd

  local quoted_cmd
  printf -v quoted_cmd "%q " "${_EMU_CMD[@]}"
  quoted_cmd="${quoted_cmd% }"

  if command -v sg >/dev/null 2>&1 && getent group kvm | grep -Eq "(^|:|,)${USER}(,|$)"; then
    sg kvm -c "setsid -f ${quoted_cmd} >/tmp/aterm-android-emulator.log 2>&1"
    return
  fi

  setsid -f "${_EMU_CMD[@]}" >/tmp/aterm-android-emulator.log 2>&1
}

start_emulator() {
  if [[ ! -x "${ANDROID_SDK_ROOT}/emulator/emulator" ]]; then
    echo "Emulator binary not found: ${ANDROID_SDK_ROOT}/emulator/emulator" >&2
    echo "Install it with scripts/install-android-emulator.sh or set ANDROID_SDK_ROOT." >&2
    exit 1
  fi

  local emulator_cmd
  emulator_cmd="$(build_emulator_command)"

  echo "Launching Android emulator for ${AVD_NAME}"
  echo "Command: ${emulator_cmd}"
  launch_emulator_detached
  sleep 2

  local emulator_running=0
  if pgrep -af "qemu-system-(x86_64|aarch64)(-headless)?|emulator.*(${AVD_NAME}|-avd)" >/dev/null; then
    emulator_running=1
  elif adb devices 2>/dev/null | awk '$1 ~ /^emulator-/ && $2 == "device" { found=1 } END { exit found ? 0 : 1 }'; then
    emulator_running=1
  fi
  if [[ "${emulator_running}" -eq 0 ]]; then
    echo "Emulator launch failed. Check /tmp/aterm-android-emulator.log for details." >&2
    exit 1
  fi

  echo "Emulator started in background. Log: /tmp/aterm-android-emulator.log"
}

wait_for_boot() {
  require_cmd adb
  local deadline=$((SECONDS + BOOT_TIMEOUT_SECONDS))
  local state=""

  echo "Waiting for Android emulator to reach adb=device..."
  while (( SECONDS < deadline )); do
    state="$(adb devices | awk '$1 ~ /^emulator-/ { print $2; exit }')"
    if [[ "${state}" == "device" ]]; then
      break
    fi
    sleep 2
  done

  state="$(adb devices | awk '$1 ~ /^emulator-/ { print $2; exit }')"
  if [[ "${state}" != "device" ]]; then
    echo "Timed out waiting for emulator adb transport (last state: ${state:-missing})." >&2
    echo "Check /tmp/aterm-android-emulator.log for details." >&2
    exit 1
  fi

  echo "Waiting for Android boot completion..."
  while (( SECONDS < deadline )); do
    if [[ "$(adb -e shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
      echo "Android emulator is booted and ready."
      return
    fi
    sleep 2
  done

  echo "Timed out waiting for sys.boot_completed=1." >&2
  exit 1
}

prepare_chrome() {
  require_cmd adb
  local attempts=20

  for ((i = 1; i <= attempts; i++)); do
    local xml
    xml="$(get_window_dump)"

    if tap_first_matching_node "${xml}" \
      'resource-id="com.android.chrome:id/signin_fre_dismiss_button"' \
      'text="Use without an account"' \
      'resource-id="com.android.chrome:id/negative_button"' \
      'text="No thanks"' \
      'text="Dismiss"'
    then
      sleep 2
      continue
    fi

    if adb shell cat /proc/net/unix | grep -q '@chrome_devtools_remote'; then
      return 0
    fi

    sleep 2
  done

  return 1
}

forward_cdp() {
  require_cmd adb
  wait_for_boot
  adb forward "tcp:${CDP_PORT}" localabstract:chrome_devtools_remote
  echo "Forwarded Android Chrome DevTools to localhost:${CDP_PORT}"
}

open_app() {
  require_cmd adb
  wait_for_boot
  adb shell monkey -p com.android.chrome -c android.intent.category.LAUNCHER 1 >/dev/null
  sleep 2
  prepare_chrome || true
  adb shell am start \
    -a android.intent.action.VIEW \
    -d "${ATERM_URL}" \
    com.android.chrome >/dev/null
  if prepare_chrome; then
    echo "Chrome onboarding cleared and ${ATERM_URL} opened."
    return
  fi
  echo "Opened ${ATERM_URL} in Android Chrome"
}

run_browser() {
  require_cmd agent-browser
  exec agent-browser --cdp "${CDP_PORT}" "$@"
}

run_workflow() {
  doctor
  if ! adb devices | awk '$1 ~ /^emulator-/ { found=1 } END { exit found ? 0 : 1 }'; then
    start_emulator
  fi
  wait_for_boot
  forward_cdp
  open_app
  cat <<EOF

Next:
  $(basename "$0") browser
EOF
}

command="${1:-}"
shift || true

case "$command" in
  doctor)
    doctor
    ;;
  start-emulator)
    start_emulator
    ;;
  wait-boot)
    wait_for_boot
    ;;
  forward-cdp)
    forward_cdp
    ;;
  open-app)
    open_app
    ;;
  browser)
    run_browser "$@"
    ;;
  workflow)
    run_workflow
    ;;
  *)
    usage
    exit 1
    ;;
esac
