# Reboot continuity

Every session that was running before a reboot comes back afterwards, and its agent resumes the same conversation. This applies to an owner-initiated reboot and to one Nightshift coordinates.

## What Tether records

Every 60 seconds Tether writes `<stateDir>/continuity.json` (`~/.local/state/tether/<instance>/`). It lists each running session's ID, its tool, and the agent's native resume ID. The catalog already holds the session's tool, name and project. The snapshot adds only the resume ID, which the catalog cannot know:

| Tool | Resume ID source | Relaunch |
| --- | --- | --- |
| Claude Code (`claude-code`) | `~/.claude/sessions/<pid>.json` for a process in the pane (`sessionId`; `status` gives busy or idle) | `claude … --resume <id> -- "<prompt>"` |
| Codex (`codex`) | the `rollout-*.jsonl` the Codex process holds open, user thread only (not a subagent's) | `codex … resume --no-daemon <id> -- "<prompt>"` |
| Shell, or an agent with no resume ID | none | relaunched fresh |

If an agent is between conversations, the session keeps the last resume ID Tether saw.

## After boot

`tether@default` starts with the user manager (linger). Startup reconciliation then finds that the tmux servers recorded before the reboot are dead. It clears those sessions' allocation, which leaves them `pending`. Each session that was running in the snapshot and is now `pending` gets restored:

1. Tether waits up to 5 minutes for `DISPLAY` or `WAYLAND_DISPLAY` to reach the user manager, so restored panes have the desktop session.
2. It recreates each session in its project directory and launches the tool. When the session has a resume ID, the launch uses the tool's resume adapter and passes this prompt as an argument: "Tether resumed this session after a host reboot. Continue where you left off. …"
3. Agent admission still applies. A launch that is deferred is retried every 30 seconds for up to 15 minutes, and after that it is reported as failed.
4. If Aico is connected, Tether asks it to show each restored session.

Ending a tmux server without a reboot takes the same path. That is how the behaviour is tested without rebooting the host. An ended session is deleted from the catalog, so it is never restored.

## Nightshift interface

Both commands run on the host as the owner and use the instance's private socket.

### Before the reboot

```
tether reboot prepare [--timeout SEC] [--no-notify] [--json]
POST /v1/reboot/prepare {"timeoutSec": 300, "notify": true}
```

This refreshes the snapshot. Unless notify is off, it pastes a checkpoint request into every running agent, then waits up to the timeout for Claude agents to report idle. Codex does not report idle, so its `idle` is `null` and it never blocks readiness. The exit code is 0 when ready and 3 when not ready.

```json
{"ready": true, "bootId": "…", "sessions": [
  {"id": "0f473ff4", "name": "…", "tool": "claude-code", "agent": true,
   "resumable": true, "idle": true, "notified": true}]}
```

### After boot

```
tether reboot status --json
GET /v1/reboot/status
```

```json
{"boot_id": "…", "restore_boot_id": "…", "restore_started_at": 0, "restore_finished_at": 0,
 "restored": [{"id": "…", "name": "…", "tool": "codex", "resumed": true}],
 "failed": [{"id": "…", "name": "…", "tool": "…", "reason": "…"}],
 "pending": [], "snapshot_updated_at": 0, "snapshot_sessions": 7}
```

If `restore_boot_id` equals `boot_id`, the lists describe this boot. While `restore_finished_at` is null, restore is still running.
