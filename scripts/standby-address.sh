#!/usr/bin/env bash
# One Aico answers aico.summitflow.dev and app.summitflow.dev at a time. Both machines run a connector
# for the same tunnel and Cloudflare splits traffic between whichever are up, so the standby takes its
# connector down while the workstation's Aico and its connector answer, and back up the moment they
# don't. Anything unclear brings the standby's connector up: a machine that is off must never cost the
# owner the address. Runs each minute on the standby only (packages/jobs); says what it did and raises nothing.
set -u

unit=cloudflared-aico.service
count_file="${AICO_DATA_DIR:-$HOME/.local/state/aico}/standby-address.count"
# In a row before the standby steps back, so a workstation still starting isn't handed the phone.
checks_up="${AICO_STANDBY_ADDRESS_CHECKS:-2}"
probe='curl -s -m3 127.0.0.1:20299/ready | grep -q "\"readyConnections\":[1-9]" && curl -s -m3 -o /dev/null 127.0.0.1:3002/'

active() { systemctl is-active --quiet "$unit"; }
change() { sudo -n systemctl --no-ask-password "$1" "$unit"; }

# timeout: a workstation that dies mid-check never answers, and this check must still decide.
if timeout 15 ssh -o ConnectTimeout=3 -o BatchMode=yes workstation "$probe" 2>/dev/null; then
  seen=$(($(cat "$count_file" 2>/dev/null || echo 0) + 1))
  echo "$seen" >"$count_file"
  if ! active; then
    echo "The workstation is answering; the standby's connector is already off."
  elif [ "$seen" -ge "$checks_up" ]; then
    change stop && echo "The workstation is answering; the standby's connector is now off."
  else
    echo "The workstation is answering; the standby's connector stays on until the next check."
  fi
else
  echo 0 >"$count_file"
  if active; then
    echo "The workstation isn't answering; the standby's connector is on."
  else
    change start && echo "The workstation isn't answering; the standby's connector is now on."
  fi
fi
