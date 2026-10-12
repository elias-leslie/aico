# Agent state

Tether keeps one agent state per session: `working`, `idle`, `blocked` or `unknown`. It is on the session descriptor (`state`, `stateSource`, `stateAt`, `stateDetail`), on every `session.updated` event, and in `tether sessions diagnostics`. Aico uses it to flash a window and show the tray's "needs you" icon; `st sessions wait --until` uses it to wait for another session.

The state lives in the daemon's memory only. After a Tether restart it is rebuilt from the agents' own files within a poll.

## Inputs

**The agents' own state, polled every 2 s** for each running session. Tether finds the agent in the pane's process tree (re-searched every 15 s, or at once when the agent process exits) and reads:

- Claude Code: `~/.claude/sessions/<pid>.json`. `status` `busy` is working, `waiting` is blocked (`waitingFor` becomes `stateDetail`: `permission prompt`, `input needed`, `dialog open`), `idle` or `shell` is idle. This file is Claude Code's internal state, not a documented interface; the hook below keeps blocked detection working if it changes.
- Codex: the user thread's rollout file, which the Codex process holds open, read incrementally from the end. `task_started` is working, `task_complete` or `turn_aborted` is idle, and an unanswered `request_user_input` call is blocked. Codex does not record approval prompts in the rollout (Tether's sessions run `codex --yolo`, so there are none); if a build ever does, `exec_approval_request`-style events also count as blocked.

**Hook reports**, `POST /v1/sessions/:id/agent-event`, from the Claude Code hook in claude-config (`hooks/agent-state.sh`). The hook runs in the pane, knows its session from `AICO_WIDGET_ID`, and posts to the instance socket with a 1 s timeout; it always exits 0.

- `Notification` with `notification_type` `permission_prompt` or `elicitation_dialog`: blocked. `idle_prompt` is not blocked: Claude sends it whenever a finished turn sits idle for a minute, and a finished turn is idle.
- `UserPromptSubmit`: working.

A hook's blocked state holds until the user answers: a `UserPromptSubmit`, or a poll whose status changed after the hook fired and is not waiting. A report carrying a different conversation ID than the session's agent (a nested agent started inside the pane) is ignored.

## Not covered

Screen contents are never read. A question an agent asks in plain text at the end of its turn is `idle`, not `blocked`; only the agents' structured prompts (permission prompts, Claude's AskUserQuestion dialog, Codex's request_user_input) are `blocked`.
