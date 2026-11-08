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
Code: `packages/ops/src/session-copies.ts` (`aico shift list|show|run`), limits and exclusions in `packages/ops/data/session-copies.json`, web `GET /api/machines/session-copies`, Machines page `SessionCopies.tsx`.
Committed: sender, receiver, CLI, Machines view. Jobs `session-copies-*` are NOT in `packages/jobs/data/jobs.json` until a real run both ways is proven; without them nothing runs by itself.
Where copies live: workstation `/srv/scratch/.aico-session-copies` (hidden so the scratch sweep leaves it), standby `~/.cache/aico/session-copies`. Sender state `~/.cache/aico/session-copies-sent.json`.
To finish if this stops here: deploy (`st service rebuild aico --detach`), check `ssh aico-gem` has `aico shift`, run `aico shift run` on both, read back with `aico shift list` on the other, then add the two jobs (every_min 3, command `["../../web-server/scripts/aico","shift","run"]`, lease_s 300) and deploy.
