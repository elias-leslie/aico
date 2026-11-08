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
