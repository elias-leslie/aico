# M11a review fixes (same Codex lane; Opus review 2026-11-04)

Fix each item, add the regression test named, deploy, check it live, and update `evidence/M11a/result.json`. Same rules as briefs/M11a.md.

1. **Roles on pins (coordinator decision).** Today `packages/fleet/src/fleet.ts:265` `openLocal` ignores which peer is asking, so any enrolled peer can `exec` (`exec.ts:33`) and `control` on any other, including the workstation. The fix follows plan.md's fleet section:
   - Each pin carries a role: `full` (davion-sidarli and CT 190 `aico`) or `worker` (agent VMs and neri-hunters, from M11b).
   - A `full` peer may open `exec`, `control`, `sync` and `jobs`.
   - A `worker` peer may open only `sync` and `jobs`. Workers still accept `exec` and `control` from full peers.
   - The enrollment ask states the role, and the two existing pins become `full`.
   - The jobs channel gets the caller's pinned name, and `who.machine` (`packages/jobs/src/fleet-leases.ts:39`) must equal it.
   - Tests: a worker is refused exec and control; a lease `who` that doesn't match the pinned name is refused.
2. **Stale connection blocks reconnect** (`fleet.ts:117-121`). The newly authenticated connection replaces the old one, which is destroyed. Don't reset the backoff before a connection has stayed up a while. Test: half-open replacement.
3. **Liveness on received bytes only** (`connection.ts:47`, `fleet.ts:160`). `socket.setTimeout` resets on our own writes, for example the 15 s event heartbeat. Measure silence from `lastSeen`, which counts only received bytes, on an interval. Keep the 5-minute wire-silence bound. Test: our own writes don't keep a dead peer alive.
4. **host-steward still uses SSH** (`native/host-steward/aico-root-watch.py:818-821,996`). Move it onto the fleet exec socket (`tether fleet exec <exec.sock> --`) and match the new path. Fix its Python tests, which still use the old path.
5. **A link fault takes Tether down** (`tether/src/daemon.ts:788-790`, and `hub.ts:186`'s unguarded timer). Catch the fault, log it, write the link Status row as failed, and retry; the local daemon keeps running. Test: the fleet throws at start and Tether still serves.
6. **Approval replay** (`fleet-cli.ts:16-22`). Each ask can be used once: record its id in the pins file. Put the key fingerprint in the question and check the full key.
7. **Smaller items:**
   - `hosts.json` `forwards` is parsed but nothing uses it. Either carry it over the link, or remove it if nothing needs it; say which.
   - Each frame reads the allowlist again (`connection.ts:82`). Cache it and reload it when the file changes.
   - A peer can open unlimited channels. Cap the open channels per peer, and pause the socket when buffers are full (`connection.ts:162`).

Report (≤15 lines): commits, each item, the tests and the live checks.
