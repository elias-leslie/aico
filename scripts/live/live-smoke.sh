#!/usr/bin/env bash
# Live agent smoke against the RUNNING Tether daemon. Not part of the commit gate.
#
#   scripts/live-smoke.sh [claude-code|codex|pi|agy ...]        default: all four
#
# Per installed tool: start a throwaway session in a scratch dir on a cheap model, wait for
# agent state idle, send a short prompt and see state go working then idle, make one idle
# delivery (POST /v1/sessions/:id/deliveries) with a SMOKE-<random> line and see it reach
# the agent, then End the session (trap: also on failure or Ctrl-C).
#
# These are real agents and cost money: cheap models, one short prompt each. claude-code,
# codex and pi start as roots (POST /v1/roots, the only create that takes a model); agy is
# not root-capable and has no model flag in its registry row, so it starts with
# POST /v1/sessions on its default model.
#
# Environment: TETHER_INSTANCE (default "default"), SMOKE_IDLE_SECONDS (90),
# SMOKE_STEP_SECONDS (90), SMOKE_CLAUDE_MODEL (haiku), SMOKE_CODEX_MODEL (gpt-6-luna),
# SMOKE_PI_MODEL (opencode-go/deepseek-v4.1-flash). Exit: 0 all installed tools passed,
# 1 a tool failed, 2 usage or no daemon.
set -uo pipefail
unset TMUX TMUX_PANE

instance=${TETHER_INSTANCE:-default}
sock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/tether/$instance/control.sock"
idle_wait=${SMOKE_IDLE_SECONDS:-90}
step_wait=${SMOKE_STEP_SECONDS:-90}
claude_model=${SMOKE_CLAUDE_MODEL:-haiku}
codex_model=${SMOKE_CODEX_MODEL:-gpt-6-luna}
pi_model=${SMOKE_PI_MODEL:-opencode-go/deepseek-v4.1-flash}

tools=("$@")
((${#tools[@]})) || tools=(claude-code codex pi agy)
for t in "${tools[@]}"; do
  case $t in claude-code | codex | pi | agy) ;; *) echo "usage: $0 [claude-code|codex|pi|agy ...]" >&2; exit 2 ;; esac
done
[[ -S $sock ]] || { echo "tether@$instance is not listening at $sock" >&2; exit 2; }

work=$(mktemp -d /tmp/tether-live-smoke.XXXXXX)
blank_root="${XDG_DATA_HOME:-$HOME/.local/share}/aico/blank-slate"
scratches=()
declare -A started    # session id -> tool, every session this run created
current_sid=
res_status=; res_body=

log() { printf '[%s] %s\n' "$(date +%T)" "$*" >&2; }
api() { # METHOD PATH [JSON]; sets res_status and res_body
  local args=(-sS --unix-socket "$sock" -X "$1" -o "$work/body" -w '%{http_code}' --max-time 60)
  [[ -n ${3:-} ]] && args+=(-H 'content-type: application/json' --data "$3")
  res_status=$(curl "${args[@]}" "http://tether$2" 2>"$work/err") || res_status=000
  res_body=$(cat "$work/body" 2>/dev/null)
  [[ $res_status != 000 ]] || res_body=$(cat "$work/err")
}
desc() { api GET "/v1/sessions/$1"; [[ $res_status == 200 ]] && printf '%s' "$res_body"; }
end_session() {
  local sid=$1 gen
  gen=$(desc "$sid" | jq -r '.generation // empty' 2>/dev/null)
  if [[ -n $gen ]]; then
    api POST "/v1/sessions/$sid/end" "{\"generation\":\"$gen\"}"
    log "ended $sid (HTTP $res_status)"
  else
    log "end $sid: no generation (HTTP $res_status), already gone?"
  fi
}
cleanup() {
  local code=$? sid
  trap - EXIT INT TERM HUP
  for sid in "${!started[@]}"; do end_session "$sid"; done
  for sid in "${scratches[@]}"; do rm -rf -- "$sid"; done
  rm -rf -- "$work"
  exit "$code"
}
trap cleanup EXIT
trap 'log "interrupted"; exit 130' INT TERM HUP

# --- per-tool run -------------------------------------------------------------------
fail_reason=; trans=; deliv=; t_idle=; t_work=; t_deliv=
note() { # append a state to the trail unless it repeats the last one
  [[ ${trans##*[>|]} == "$1" ]] && return
  [[ -z $trans || $trans == *'|' ]] || trans+='>'
  trans+=$1
}

state_of() { printf '%s' "$1" | jq -r '"\(.state)/\(.stateSource)"'; }

# poll DESC_VAR until predicate on the state; args: seconds predicate-state (working|idle)
# Records every state change in $trans. Returns 0 when reached, 1 on timeout, 2 when the session left running.
wait_state() {
  local want=$1 limit=$2 end last='' d s st
  end=$((SECONDS + limit))
  while ((SECONDS < end)); do
    d=$(desc "$current_sid") || { sleep 1; continue; }
    st=$(printf '%s' "$d" | jq -r .status)
    s=$(printf '%s' "$d" | jq -r .state)
    [[ $st == running ]] || { fail_reason="session status $st while waiting for $want"; return 2; }
    if [[ $s != "$last" ]]; then
      log "  state=$s source=$(printf '%s' "$d" | jq -r .stateSource)"
      note "$s"; last=$s
    fi
    [[ $s == "$want" ]] && return 0
    sleep 1
  done
  fail_reason="no state $want within ${limit}s (last=$last)"
  return 1
}

capture() { api GET "/v1/sessions/$current_sid/capture"; printf '%s' "$res_body" | jq -r '.text // empty'; }

run_tool() {
  local tool=$1 model='' effort='' rid sid d gen scratch body marker t0 deadline s dstate id
  resent=; fail_reason=; trans=; deliv=no; t_idle=-; t_work=-; t_turn=-; t_deliv=-; current_sid=
  case $tool in
    claude-code) model=$claude_model; effort=low ;;
    codex) model=$codex_model; effort=low ;;
    pi) model=$pi_model; effort=low ;;
  esac
  # Blank Slate workspace (an empty dir Tether keys the mode on): no project context and no
  # folder-trust dialog. agy has no Blank Slate row, so it gets a plain scratch dir.
  if [[ $tool == agy ]]; then
    scratch=$(mktemp -d /tmp/tether-live-smoke-proj.XXXXXX)
  else
    scratch="$blank_root/live-smoke-$tool-$$-$RANDOM"; mkdir -p "$scratch"
  fi || { fail_reason='scratch dir failed'; return 1; }
  scratches+=("$scratch")
  rid="live-smoke-$tool-$(date +%s)-$RANDOM"
  t0=$SECONDS
  log "$tool: starting (model=${model:-default} effort=${effort:-default}) in $scratch"
  if [[ $tool == agy ]]; then
    body=$(jq -nc --arg r "$scratch" '{tool:"agy",origin:"cli",projectRoot:$r,name:"live-smoke",size:{cols:120,rows:40}}')
    api POST /v1/sessions "$body"
  else
    body=$(jq -nc --arg rid "$rid" --arg t "$tool" --arg r "$scratch" --arg m "$model" --arg e "$effort" \
      '{requestId:$rid,tool:$t,projectId:"blank-slate",projectRoot:$r,initialPrompt:"Reply with only the word ready.",role:"live-smoke",workRole:"other",model:$m,reasoningEffort:$e}')
    api POST /v1/roots "$body"
  fi
  case $res_status in 200 | 201 | 202) ;; *) fail_reason="create HTTP $res_status: $res_body"; return 1 ;; esac
  sid=$(printf '%s' "$res_body" | jq -r '.id // (.surfaceLocator // "" | sub("^aico://widget/"; "")) // empty')
  [[ -n $sid ]] || { fail_reason="create gave no session id: $res_body"; return 1; }
  started[$sid]=$tool; current_sid=$sid
  log "$tool: session $sid"

  # 1/2: running, then idle. The first (initial-prompt) turn may come first; wait for a settled idle.
  deadline=$((SECONDS + idle_wait))
  until [[ $(desc "$sid" | jq -r .status 2>/dev/null) == running ]]; do
    ((SECONDS < deadline)) || { fail_reason="not running within ${idle_wait}s: $res_body"; return 1; }
    sleep 1
  done
  wait_state idle "$idle_wait" || return 1
  for _ in 1 2 3; do # settle: idle must hold, not be the gap before the initial prompt starts
    sleep 1
    [[ $(desc "$sid" | jq -r .state) == idle ]] || { wait_state idle "$idle_wait" || return 1; }
  done
  t_idle=$((SECONDS - t0))
  log "$tool: idle after ${t_idle}s"

  # 3: prompt -> working -> idle
  d=$(desc "$sid"); gen=$(printf '%s' "$d" | jq -r .generation)
  trans+='|'; note idle
  marker="run the shell command sleep 6, then count from 1 to 5, one number per line, then say done"
  t0=$SECONDS
  for attempt in 1 2; do
    api POST "/v1/sessions/$sid/inject" "$(jq -nc --arg g "$gen" --arg t "Please $marker" '{generation:$g,mode:"paste",text:$t,submit:true}')"
    [[ $res_status == 200 ]] || { fail_reason="inject HTTP $res_status: $res_body"; return 1; }
    # A turn that never starts and leaves no trace on screen means the TUI dropped the paste
    # (agy does this for the first prompt in a project dir it has not seen). Say so and send once more.
    wait_state working "$((attempt == 1 ? 25 : step_wait))" && break
    if ((attempt == 1)) && ! capture | grep -Fq 'sleep 6'; then
      log "$tool: WARN prompt was not taken (no working state, text not on screen); sending it once more"
      fail_reason=; resent=yes; continue
    fi
    return 1
  done
  t_work=$((SECONDS - t0))
  log "$tool: working after ${t_work}s"
  wait_state idle "$step_wait" || return 1
  t_turn=$((SECONDS - t0))
  log "$tool: back to idle after ${t_turn}s"
  for _ in 1 2 3; do sleep 1; done

  # 4: one idle delivery through the gated path
  marker="SMOKE-$RANDOM$RANDOM"
  trans+='|'; note idle
  api POST "/v1/sessions/$sid/deliveries" "$(jq -nc --arg l "$marker" '{source:"smoke:live",line:$l}')"
  case $res_status in 200 | 201) ;; *) fail_reason="delivery HTTP $res_status: $res_body"; return 1 ;; esac
  id=$(printf '%s' "$res_body" | jq -r .id)
  t0=$SECONDS; deadline=$((SECONDS + step_wait)); dstate=queued
  log "$tool: delivery $id queued ($marker), waiting for the gated delivery"
  while ((SECONDS < deadline)); do
    api GET "/v1/deliveries/$id"
    dstate=$(printf '%s' "$res_body" | jq -r '.state')
    [[ $dstate == queued ]] || break
    sleep 1
  done
  t_deliv=$((SECONDS - t0))
  [[ $dstate == delivered ]] || { fail_reason="delivery state=$dstate after ${t_deliv}s: $res_body"; return 1; }
  deliv="$(printf '%s' "$res_body" | jq -r '.via')"
  log "$tool: delivery $dstate via $deliv after ${t_deliv}s"
  # The text must have reached the agent: on screen, or the agent turned to work on it.
  deadline=$((SECONDS + 30)); local seen=''
  while ((SECONDS < deadline)); do
    if capture | grep -Fq "$marker"; then seen=screen; break; fi
    s=$(desc "$sid" | jq -r .state)
    if [[ $s == working ]]; then seen=working; break; fi
    sleep 1
  done
  [[ -n $seen ]] || { fail_reason="delivery $id marked delivered via $deliv but $marker never appeared on screen and the agent never worked"; return 1; }
  deliv+="+$seen"
  log "$tool: delivery reached the agent ($deliv)"
  return 0
}

# Why a tool stays out tonight, from the route it would run on (aico models route), else nothing: with
# no plan it can't pass and that isn't Aico breaking, and a nightly check isn't worth paid credits.
# Skipped, not failed. Unreadable: run it.
not_tonight() {
  local model=
  case $1 in claude-code) model=$claude_model ;; codex) model=$codex_model ;; pi) model=$pi_model ;; esac
  "${AICO_CLI:-aico}" models route --role lookup --tool "$1" ${model:+--model "$model"} --json 2>/dev/null |
    jq -r '.rows[0].usage | if .status == "no_plan" then "no plan since \(.plan_ended_at)" elif .status == "on_credits" then "on credits" else empty end' 2>/dev/null
}

declare -a rows=() failed_tools=() skipped=() out=()
failed=0
for tool in "${tools[@]}"; do
  bin=$tool; [[ $tool == claude-code ]] && bin=claude
  if ! command -v "$bin" >/dev/null 2>&1; then
    printf 'SKIP %s: not installed\n' "$tool"
    rows+=("$tool"$'\t'SKIP$'\t'"not installed"$'\t\t\t\t')
    continue
  fi
  why=$(not_tonight "$tool")
  if [[ -n $why ]]; then
    printf 'SKIP %s: %s\n' "$tool" "$why"
    rows+=("$tool"$'\t'SKIP$'\t'"$why"$'\t\t\t\t')
    out+=("$tool ($why)")
    continue
  fi
  start=$SECONDS
  if run_tool "$tool"; then
    status=PASS; reason=${resent:+first prompt had to be sent twice}
  else
    status=FAIL; reason=$fail_reason; screen=
    if [[ -n $current_sid ]]; then
      screen=$(capture)
      log "$tool: FAIL evidence ---- descriptor"; desc "$current_sid" >&2 || echo "$res_body" >&2
      log "$tool: pane capture ----"; printf '%s\n' "$screen" >&2
    fi
    # The tool's provider refused for quota (e.g. OpenCode Go used up): nothing Aico can fix tonight.
    if grep -qiE 'usage limit|rate limit|quota|\b429\b' <<<"$screen"; then
      status=SKIP; reason="provider usage limit ($fail_reason)"; skipped+=("$tool")
    else
      failed=$((failed + 1)); failed_tools+=("$tool")
    fi
  fi
  [[ -z ${current_sid:-} ]] || { end_session "$current_sid"; unset "started[$current_sid]"; }
  total=$((SECONDS - start))
  printf '%s %s: states=%s delivery=%s idle=%ss work=%ss deliver=%ss total=%ss%s\n' \
    "$status" "$tool" "${trans:--}" "${deliv:--}" "$t_idle" "$t_work" "$t_deliv" "$total" "${reason:+ -- $reason}"
  rows+=("$tool"$'\t'"$status"$'\t'"${reason:-ok}"$'\t'"${trans:--}"$'\t'"$deliv"$'\t'"idle ${t_idle}s, working ${t_work}s, turn ${t_turn}s, deliver ${t_deliv}s"$'\t'"${total}s")
done

echo
printf '%-12s %-5s %-46s %-14s %-44s %s\n' TOOL RESULT STATES DELIVERY TIMINGS TOTAL
for r in "${rows[@]}"; do
  IFS=$'\t' read -r t st why tr dl tm tot <<<"$r"
  printf '%-12s %-5s %-46s %-14s %-44s %s%s\n' "$t" "$st" "$tr" "$dl" "$tm" "$tot" "$([[ $why == ok ]] || echo "  ($why)")"
done

# Leftover check: none of this run's sessions may still be running.
left=0
for sid in "${!started[@]}"; do end_session "$sid"; done
started=()
api GET /v1/sessions
if [[ $res_status == 200 ]]; then
  while read -r sid root; do
    log "LEFTOVER $sid ($root)"; left=$((left + 1))
  done < <(printf '%s' "$res_body" | jq -r '.items[]? | select(.status=="running" and ((.projectRoot // "") | test("/live-smoke-|/tether-live-smoke-proj[.]"))) | "\(.id) \(.projectRoot)"' 2>/dev/null)
fi
((left == 0)) || { echo "$left session(s) left running"; failed=$((failed + left)); }
# Last line: the nightly Status row shows it.
summary="live-smoke: ${#failed_tools[@]} tool(s) failed${failed_tools[*]:+ (${failed_tools[*]})}"
((${#skipped[@]})) && summary+=", skipped for provider limits: ${skipped[*]}"
((${#out[@]})) && summary+=", skipped: ${out[*]}"
((left == 0)) || summary+=", $left session(s) left running"
((failed == 0)) && summary="live-smoke passed${skipped[*]:+ (skipped for provider limits: ${skipped[*]})}${out[*]:+ (skipped: ${out[*]})}"
echo "$summary"
((failed == 0))
