# Crash recovery

When a session dies and nobody ended it, Tether resumes the same session in place: same widget, window, origin, coordinator and root request, with the agent's own conversation. The agent's first prompt says what happened and what to check first. This is the second announced exception to "no silent resurrection" in [ADR 0001](adr/0001-tether-owns-sessions.md); reboot restore ([reboot-continuity.md](reboot-continuity.md)) is the first.

## What counts as a crash

| What died | How Tether proves it | Kind |
| --- | --- | --- |
| The pane scope (for example an OOM kill while the pane is on `OOMPolicy=stop`) | The user journal has a failure result for that exact scope unit and invocation ID: `oom-kill`, `signal`, `core-dump`, `timeout` or `exit-code` | `pane-stopped` |
| The agent only; the pane fell back to its shell | The supervisor exports the agent's exit status as `TETHER_AGENT_EXIT` into the fallback shell. 137 (SIGKILL, which is what an OOM kill sends) and the crash signals 132, 134, 135, 136 and 139 count. 0 (`/exit`) and the stop signals 129, 130 and 143 do not | `agent-exited` |
| The tmux server, while Tether kept running | The server unit's journal result is a failure, the kernel OOM-killed a process in it, or continuity saw the agent running in the last 150 seconds. tmux runs as a non-main process of an `ExitType=cgroup` unit, so a killed server leaves no failure result; cause `lost` | `server-died` |

The kernel log (`journalctl -k`) adds the OOM victim: its pid, command name, memory, and whether the host or a cgroup cap ran out. When the victim is the agent's own process, the session is marked `agent_was_hog`.

These never recover:

- **An End** (Aico discard, `st aico root end`, `tether sessions end`, fleet close). End deletes the row, and with it any crash record.
- **A clean exit:** a pane whose scope ended without a failure result, or an agent that exited with 0.
- **A killed child in a live pane.** On `OOMPolicy=continue` the kernel kills only the biggest process; when that is a job and the agent keeps running, nothing needs recovering.
- **A reboot or a Tether restart.** Startup reconciliation leaves these to reboot continuity, which resumes with the reboot prompt as before.

## What Tether does

1. It keeps the agent's resume ID. The crash record in `<stateDir>/recoveries.json` holds it, and `continuity.json` keeps the session listed while the record is open.
2. Until the resume starts, a plain attach cannot launch a fresh agent in the session's place.
3. It waits until host admission (Nightshift's memory verdict) has allowed agent launches for 60 seconds, and at least 60 seconds after the crash was found.
4. It writes a detail file, `<stateDir>/recovery/<widget>-<time>.md`, with the raw unit and kernel journal lines, memctl's lines, `nightshift memory events` when that command exists, the calls that were killed or in flight, unfinished workflows with their script paths, background jobs that never reported back, `git status --short` and the session's leases.
5. It relaunches the agent with its resume adapter and a prompt of at most 2000 bytes: when and why it died, the likely culprit, the code state, unfinished workflows, which attempt this is, the detail file path, and what to do first. Facts come from the journal, the transcripts and git, never from the screen.
   - `pane-stopped` and `server-died`: the session is recreated through the reboot-restore launch path.
   - `agent-exited`: the pane is respawned, which ends whatever was still running in it.
6. If Aico is connected, Tether asks it to show the session.

Transcript facts come from a per-tool adapter. Claude Code has one: the main transcript, subagent transcripts and workflow journals under `~/.claude/projects/`. Codex has none, so its prompt has no workflow or culprit lines.

## Loop protection

- At most 2 automatic recoveries per session in a rolling 6 hours.
- The second starts at least 10 minutes after the first.
- A crash within 10 minutes of a recovery is held, not relaunched.
- An agent that was itself the memory hog is resumed once, with a warning to save notes, compact and keep large outputs out of context. A second such crash is held.
- One recovery runs at a time, so several sessions that crashed together come back one by one through admission.
- A launch that admission defers is retried every 30 seconds; after 15 minutes of refusals the session is held.

A held session stays `uncertain`. Its record says why, and Nightshift pushes the owner. `tether recovery resume <id>` tries it again at once, outside the limits.

While a record is waiting or held, `st aico create --resume-session` for the same conversation is refused with `409 recovery_pending` and the widget that owns it, so two agents never resume one conversation.

## Status for Nightshift

```
tether recovery status [--json]
GET /v1/recovery/status
POST /v1/recovery/<id>/resume      202, or 409 not_held
```

```json
{
  "v": 1,
  "boot_id": "…",
  "updated_at": 1792153828000,
  "max_attempts": 2,
  "window_hours": 6,
  "sessions": [
    {
      "id": "236eb8e2", "name": "Cinderwake", "tool": "claude-code", "origin": "aico",
      "root_request_id": null, "coordinator_id": null,
      "state": "recovered",
      "kind": "pane-stopped", "cause": "oom-kill", "signal": null, "agent_was_hog": false,
      "victim": { "pid": 192829, "comm": "python", "rss_bytes": 14213173248, "constraint": "global" },
      "died_at": 1792121278651, "detected_at": 1792121281000, "recovered_at": 1792121400000,
      "attempt": 1, "not_before": null, "reason": null,
      "detail_file": "/home/…/.local/state/tether/default/recovery/236eb8e2-2026-10-16T03-27-58-651Z.md",
      "resumable": true, "resume_command": null
    }
  ]
}
```

`state` is `waiting`, `recovering`, `recovered` or `held`. Times are epoch milliseconds. `reason` says why a session waits or is held. `resume_command` is set for held sessions. A record whose session was ended disappears; recovered and held records stay for 24 hours. Push keys should combine `id`, `died_at` and `attempt`.

## Fleet roots

A recovered root has a new generation. SummitFlow's fleet ledger does not yet accept a generation change that Tether vouches for, so `st sessions close` on it reports close-uncertain, as it already does after a reboot restore.
