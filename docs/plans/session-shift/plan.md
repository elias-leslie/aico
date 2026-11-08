# Sessions shift between Aico machines (owner agreed Nov 8)

Owner: agents "can and should be able to shift to davion-gem if i want to shutdown davion-sidarli", and pick up or understand what was going on when either machine crashes or locks up. Not perfect, no ceremony, no clutter, no context waste, no bloat.

## Level 1: always know what was going on
Each active agent session's conversation, its project's uncommitted changes and a short "what I was doing" reach the other full Aico within a few minutes. Only active sessions, only changes. Reuse the existing sync (context-sync, peer-sync, wip-mirror) rather than building a new one. The surviving machine shows what was running on the other one. Copies are bounded, cleaned up, and quiet: a machine being off isn't a failure.

## Level 2: planned shift
"Move to standby" for a session, and as part of a clean shutdown (`aico power`): stop at a safe point, copy state, resume the same conversation on the other machine with a true account of what moved and what didn't. Works either way between machines. Only for projects that exist on both; others say they stay and wait. Different agent tool: no fake resume, a handoff summary instead. On a crash the survivor offers "continue here" with one tap.

## Not doing
Moving live processes. Automatic takeover on a crash: a machine that only looks down would give two agents the same work. The resumed agent always re-checks live state and half-finished work first.

## State
Update this section at each verified step, so the next agent, on any tool, can continue.

### Level 1 (2026-11-08)
Code: `packages/ops/src/session-copies.ts` (`aico shift list|show|run`), limits and exclusions in `packages/ops/data/session-copies.json`, web `GET /api/machines/session-copies`, Machines page `SessionCopies.tsx`. Jobs `session-copies-davion-sidarli` and `session-copies-aico` in `packages/jobs/data/jobs.json`, every 3 min. To turn it off: delete those two jobs and deploy.
Where copies live: workstation `/srv/scratch/.aico-session-copies` (hidden so the scratch sweep leaves it), standby `~/.cache/aico/session-copies`. Each machine folder has `snapshot.json`, `ended.json`, `sessions/<id>/files/<path below home>`; `removed.log` beside them. Sender state `~/.cache/aico/session-copies-sent.json`; deleting it only re-checks sizes. Removal rules are in `pruneCopies`.
Proven by real runs at 12:47-12:50 PM: both ways, read back on the other machine, copies byte-identical in size and first 1 MB to their sources, modes 0700/0600, a run with no link says "not connected" and exits 0, and the last copy stays readable.
Real outage, 1:40-1:43 PM (davion-gem rebooted): the 1:42 run said "not connected" and exited 0, Status stayed ok with no notice, the workstation kept the standby's last list, and the 1:45 run caught up with 22 MB. Standby holds 338 MB after a day's first hours; a session over its 128 MB cap sheds oldest subagent files, logged in `removed.log`.
Level 1 is finished. Level 2 is not started; the roadmap line stays for it.
Not covered: tool-results folders, sessions on worker hosts, sessions with no project folder, last messages for Antigravity (it gets its state and database copy), aico-agent transcripts, ignored files in repos, a session long idle before Level 1 started until it next moves.
For Level 2: a held conversation is at `aico shift show ID` (copy path, tool, conversation id, cwd); uncommitted work comes from `aico wip restore PROJECT --of MACHINE --to DIR`. The copy keeps the source's path below the home, so restoring is copying `files/` over the home. A trimmed copy (cut true) starts at a later line of the conversation.
