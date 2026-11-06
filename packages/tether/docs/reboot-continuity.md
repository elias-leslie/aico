# Reboot continuity

Every session that was running before a reboot comes back afterwards, and its agent resumes the same conversation. This applies to an owner-initiated reboot and to one Nightshift coordinates.

## What Tether records

Every 60 seconds Tether writes `<stateDir>/continuity.json` (`~/.local/state/tether/<instance>/`). It lists each running session's ID, its tool, and the agent's native resume ID. The catalog already holds the session's tool, name and project. The snapshot adds only the resume ID, which the catalog cannot know:

| Tool | Resume ID source | Relaunch |
| --- | --- | --- |
| Claude Code (`claude-code`) | `~/.claude/sessions/<pid>.json` for a process in the pane (`sessionId`; `status` gives busy or idle) | `claude … --resume <id> -- "<prompt>"` |
| Codex (`codex`) | the `rollout-*.jsonl` the Codex process holds open, user thread only (not a subagent's) | `codex … resume --no-daemon <id> -- "<prompt>"` |
| Pi (`pi`) | Pi keeps no per-process session record, so a root or prompted launch starts it with `--session-id <id>` under an ID Tether picks and passes as `TETHER_AGENT_SESSION_ID` in the agent's environment | `pi … --session <id> -- "<prompt>"` |
| Shell, or an agent with no resume ID | none | relaunched fresh (a shell restore cannot relaunch is ended, see [crash recovery](crash-recovery.md)) |

If an agent is between conversations, the session keeps the last resume ID Tether saw.

## After boot

`tether@default` starts with the user manager (linger). Startup reconciliation then finds that the tmux servers recorded before the reboot are dead. It clears those sessions' allocation, which leaves them `pending`. Each session that was running in the snapshot and is now `pending` gets restored:

1. Tether waits up to 5 minutes for `DISPLAY` or `WAYLAND_DISPLAY` to reach the user manager, so restored panes have the desktop session.
2. It recreates each session in its project directory and launches the tool. When the session has a resume ID, the launch uses the tool's resume adapter and passes this prompt as an argument: "Tether resumed this session after a host reboot. Continue where you left off. …"
3. Agent admission still applies. Deferred admission, an unavailable reservation, and an entry's exit 75 (temporary prerequisites) stay pending and retry every 30 seconds until the prerequisites return. Pending attempts and their original conversation IDs survive a Tether restart. There is no elapsed-time cutoff for these conditions.
4. If Aico is connected, Tether asks it to show each restored session.

An agent is restored only after its live process reports the expected conversation. A dispatched launch or a fallback shell does not count. Entries can configure a read-only `probe` in `entries.json`; its JSON must confirm a live native agent, host PID and conversation ID. Entry exit 78 means a configuration or ownership failure and is reported as failed/held, with `tether recovery resume <id>` after repair. Other launch exits and a launch with no matching agent after two minutes are failures, never successes.

Placement keeps each root's original host, memory, CPUs and capabilities in the existing placement owner's durable `placement_intents` setting. Restore and crash recovery on this computer rebook those needs before launching, even if the active reservation disappeared. A root on a remote host is restored by that host's own Tether, which has no placement step: the hub releases its booking when the agent exits and books the recorded needs on that host again at its next placement decision or dry run after the root reports live. A repeat `POST /v1/roots` for an ended or exited root is not a booking: it answers as before (no-op, or 410 once ended) without judging room. Recovering and held entry sessions retain their booking. Ending a root removes its placement metadata. Existing bookings are carried into this metadata on upgrade. If an old booking had already disappeared before the upgrade, its needs cannot be reconstructed from nothing: seed the known values once with `tether recovery resume <id> --mem-bytes N --cpus N`. Later recovery uses the recorded values automatically; it never replays the original prompt.

Ending a tmux server and then restarting Tether takes the same path. That is how the behaviour is tested without rebooting the host. A server, pane or agent that dies while Tether keeps running goes through [crash recovery](crash-recovery.md) instead, with its own prompt and loop limits. An ended session is deleted from the catalog, so it is never restored.

## Nightshift interface

Both commands run on the host as the owner and use the instance's private socket.

### Before the reboot

```
tether reboot prepare [--timeout SEC] [--no-notify] [--json]
POST /v1/reboot/prepare {"timeoutSec": 300, "notify": true}
```

This refreshes the snapshot. Unless notify is off, it pastes a checkpoint request into every running agent except a Claude agent sitting at a permission prompt or question (submitting a paste there could pick the prompt's default answer; its `notified` is false), then waits up to the timeout for Claude agents to report idle. A Claude agent at a prompt counts as idle, so it does not block readiness either. Codex does not report idle, so its `idle` is `null` and it never blocks readiness. The exit code is 0 when ready and 3 when not ready.

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
