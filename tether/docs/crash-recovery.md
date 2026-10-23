# Crash recovery

When a session dies and nobody ended it, Tether resumes the same session in place: same widget, window, origin, coordinator and root request, with the agent's own conversation. The agent's first prompt says what happened and what to check first. This is the second announced exception to "no silent resurrection" in [ADR 0001](adr/0001-tether-owns-sessions.md); reboot restore ([reboot-continuity.md](reboot-continuity.md)) is the first.

## What counts as a crash

| What died | How Tether proves it | Kind |
| --- | --- | --- |
| The pane scope (for example an OOM kill while the pane is on `OOMPolicy=stop`) | The user journal has a failure result for that exact scope unit and invocation ID, logged no later than 10 seconds after Tether saw the pane go: `oom-kill`, `signal`, `core-dump` or `exit-code`. `timeout` never counts: on a pane it only comes from a stop that took too long, such as Tether's own cleanup | `pane-stopped` |
| Every process in the pane, killed at once from outside (for example `systemctl --user kill -s KILL` on the scope) | The scope then simply empties, so systemd logs no failure. The pane supervisor writes `started` to `<runtimeDir>/agent-exits/<scope unit>` before it starts the agent and `exit N` as soon as the agent exits (`signal HUP` or `signal TERM` when the pane is closed or stopped). A closed pane sends no signal: its pty hangs up and the kernel sends SIGHUP to the supervisor alone, so the supervisor runs the agent as a child it waits on and passes a HUP or TERM on to the pane's process group, then records it once the agent is gone. A scope that ended with no failure, before Tether saw the pane go, while that file still says `started` was killed with the agent running, even if its tmux server then exited empty. A scope that ends only once Tether stops what outlived the pane is not a kill. A pane started before this marker existed, or an agent the owner started again by hand in the fallback shell after the supervisor wrote its exit, counts when systemd logged `Sending signal SIGKILL to process` for that scope before Tether saw it go (`systemctl kill` logs that; Tether's own cleanup uses `cgroup.kill` and comes later). The death time is that kill record, else an OOM kill in the pane within 5 s of it, else the scope's end record | `pane-stopped`, cause `killed` |
| The agent only; the pane fell back to its shell | The supervisor exports the agent's exit status as `TETHER_AGENT_EXIT` into the fallback shell. 137 (SIGKILL, which is what an OOM kill sends) and the crash signals 132, 134, 135, 136 and 139 count. 0 (`/exit`) and the stop signals 129, 130 and 143 do not | `agent-exited` |
| The tmux server, while Tether kept running | The server unit's journal result is a failure, the kernel OOM-killed a process in it, or continuity saw the agent running in the last 150 seconds and no pane on that server exited since. tmux runs as a non-main process of an `ExitType=cgroup` unit, so a killed server leaves no failure result; cause `lost`. A pane that exits runs tmux's pane-exited hook and a killed server does not, so an owner `/exit` and `exit` in the last session is not read as a crash | `server-died` |

The kernel log (`journalctl -k`) adds the OOM victim: its pid, command name, memory, and whether the host or a cgroup cap ran out. When the victim is the agent's own process, the session is marked `agent_was_hog`.

These never recover:

- **An End** (Aico discard, `st aico root end`, `tether sessions end`, fleet close). End deletes the row, and with it any crash record.
- **A clean exit:** a pane whose scope ended without a failure result after its agent exited (the owner typed `/exit`, then `exit`), or an agent that exited with 0.
- **A killed child in a live pane.** On `OOMPolicy=continue` the kernel kills only the biggest process; when that is a job and the agent keeps running, nothing needs recovering.
- **A reboot or a Tether restart.** Startup reconciliation leaves these to reboot continuity, which resumes with the reboot prompt as before.
- **A shutdown or logout.** Nothing that ends while the host or the user manager reports `stopping` is read as a crash.
- **An agent the owner restarted by hand.** When continuity or the recovery step finds an agent running in the session again, the record is dropped and nothing is relaunched. That fallback shell is never recorded again.

## What Tether does

1. It keeps the agent's resume ID. The crash record in `<stateDir>/recoveries.json` holds it, and `continuity.json` keeps the session listed while the record is open.
2. Until the resume starts, a plain attach cannot launch a fresh agent in the session's place.
3. It waits until host admission (Nightshift's memory verdict) has allowed agent launches for 60 seconds, and at least 60 seconds after the crash was found.
4. It writes a detail file, `<stateDir>/recovery/<widget>-<time>.md`, with the raw unit and kernel journal lines, memctl's lines, `nightshift memory events` when that command exists, the calls that were killed or in flight, unfinished workflows with their script paths, background jobs that never reported back, `git status --short` and the session's leases.
5. Just before relaunching, it checks that no other session is resuming or running the same conversation (a fresh continuity pass). If one is, the record is dropped, so two agents never share a conversation.
6. It relaunches the agent with its resume adapter and a prompt of at most 2000 bytes: when and why it died, the likely culprit, the code state, unfinished workflows, which attempt this is, the detail file path, and what to do first. Facts come from the journal, the transcripts and git, never from the screen.
   - The pane is gone (`pane-stopped`, `server-died`): the session is recreated through the reboot-restore launch path.
   - The pane is still there (`agent-exited`, or a resume that fell back to the shell): the pane is respawned, which ends whatever was still running in it.
7. The record says `recovered` only once an agent with that conversation shows up in the pane. If none does within 2 minutes (for example the conversation was not found), the session is held with "the resume did not start".
8. If Aico is connected, Tether asks it to show the session.

Transcript facts come from a per-tool adapter. Claude Code has one: the main transcript, subagent transcripts and workflow journals under `~/.claude/projects/`. Only the last 4 MB of the main transcript and 256 KB of each subagent transcript are read, once per crash. Codex has none, so its prompt has no workflow or culprit lines.

## Loop protection

- At most 2 automatic recoveries per session in a rolling 6 hours.
- The second starts at least 10 minutes after the first.
- A crash within 10 minutes of a recovery is held, not relaunched.
- An agent that was itself the memory hog is resumed once, with a warning to save notes, compact and keep large outputs out of context. A second such crash is held.
- One recovery runs at a time, so several sessions that crashed together come back one by one through admission.
- A launch that admission defers, or that finds another operation on the session in progress, is retried every 30 seconds; after 15 minutes the session is held.
- An owner resume (`tether recovery resume`) does not count toward the 2 in 6 hours, but a crash within 10 minutes of it is still held.

Holding changes nothing in the session itself, so its catalog status stays what its pane really is: `running` when the pane survived (an `agent-exited` crash: the window shows the fallback shell), `uncertain` when the pane is gone. That status says whether a verified workload is in the pane, which is what Aico and `st` act on; whether the agent needs recovering is the record's `state: "held"` in `tether recovery status`, which says why, and Nightshift pushes the owner. `tether recovery resume <id>` tries it again at once, outside the limits.

While a death is being classified, or its record is waiting or held, `st aico create --resume-session` for the same conversation is refused with `409 recovery_pending` and the widget that owns it, so two agents never resume one conversation.

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
      "died_at": 1792121278651, "died_at_approx": false, "detected_at": 1792121281000, "recovered_at": 1792121400000,
      "attempt": 1, "not_before": null, "reason": null,
      "detail_file": "/home/…/.local/state/tether/default/recovery/236eb8e2-2026-10-16T03-27-58-651Z.md",
      "resumable": true, "resume_command": null
    }
  ]
}
```

`state` is `waiting`, `recovering`, `recovered` or `held`. Times are epoch milliseconds. `died_at` comes from the best evidence of the death: the kernel's OOM record, the unit's journal result or end record, or the moment the supervisor wrote the agent's exit status. When none exists, it is the time Tether noticed (up to a minute late), `died_at_approx` is true, and the prompt says "about". `reason` says why a session waits or is held. `resume_command` is set for held sessions. A record whose session was ended disappears; recovered and held records stay for 24 hours. Detail files are removed after 7 days. Push keys should combine `id`, `died_at` and `attempt`.

## Fleet roots

A recovered root has a new generation. SummitFlow's fleet ledger does not yet accept a generation change that Tether vouches for, so `st sessions close` on it reports close-uncertain, as it already does after a reboot restore.
