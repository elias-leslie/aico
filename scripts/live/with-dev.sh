#!/usr/bin/env bash
# Runs one command against a throwaway tether@dev instance (the nightly live checks in
# .st-check.toml [[deep.stages]]): starts tether@dev if it is down, waits for its control
# socket, runs the command, and stops the instance again if this run started it.
#
#   scripts/live/with-dev.sh COMMAND [ARGS...]
set -uo pipefail
(($#)) || { echo "usage: $0 COMMAND [ARGS...]" >&2; exit 2; }
sock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/tether/dev/control.sock"
started=
if ! systemctl --user is-active -q tether@dev.service; then
  systemctl --user --no-ask-password start tether@dev.service || exit 2
  started=1
fi
trap '[[ -n $started ]] && systemctl --user --no-ask-password stop tether@dev.service' EXIT
for _ in $(seq 100); do [[ -S $sock ]] && break; sleep 0.2; done
[[ -S $sock ]] || { echo "tether@dev did not open $sock" >&2; exit 2; }
"$@"
