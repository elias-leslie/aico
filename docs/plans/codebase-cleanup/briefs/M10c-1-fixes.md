# M10c-1 review fixes (builder: Opus 5.5 high, fresh native subagent; Opus review 2026-11-04)

Context: M10c-1 (aico cf9fab3c, 80dcecb3, 385596d1, 44097fe3; SummitFlow e62c3af8, e8cb0cde, 5b4f2b3d, 45fd5f59; brief briefs/M10c-1.md) is live. `st service rebuild aico`, `st logs`, `st snap` and `st vm` go through `packages/ops`, and every builder deploys through it, so keep it working at each commit. Fix each item with the test named, deploy, check it live, and report.

1. **High: `aico vm` uses a new root SSH path** (`packages/ops/src/vm.ts:28-41`, `data/ops.json` `vm.ssh`). `st vm` used the Proxmox API token, whose pool limits Proxmox enforces: locally, or through the backend route `POST /api/vm/op` (`summitflow/backend/cli/lib/proxmox_remote.py`, `commands/vm.py:81-89`). Use that same API token path (call the route, or the same token's API with the same pool limits) and remove the SSH path. Test: a VM outside the token's pools is refused by Proxmox, not only by our list.
2. **High: `--with-ack` never reaches acceptance** (`deploy.ts:576`, the job args at `501-505`). Pass it to `aico check --acceptance` and into the detached job's arguments. Test: a rebuild under another agent's hold with a valid ack passes acceptance.
3. Re-run the hold guard inside `withLock`, just before `swapUnits`, so a queued job can't restart units under a hold taken while it waited. Test.
4. **Interrupted swap counts as deployed** (`deploy.ts:754-759`, `481`, `595`). Keep a small swap journal: an unfinished swap is rolled back, or redeployed on the next run, never reported as "Nothing to restart". Test: kill after the unit writes.
5. Check every template before writing any unit file (`deploy.ts:756`). Report "previous units restored" only when it's true. Test.
6. Under the lock, remove staging dirs (`.<sha>.<pid>`) and tars whose pid is dead (`deploy.ts:674`). Test.
7. **Two deploys holding the lock** (`deploy.ts:399-406`). Create the lock atomically with the pid in it (`writeFileSync(..., {flag:'wx'})`) and take over a stale lock by rename. Test: two waiters taking over a stale lock; only one proceeds.
8. `st vm start`'s empty `--reason` falls back to the default (`vm.ts:470-472`).
9. `st rollback`'s preview and the restore resolve `-N` the same way (`quick_snapshots.py:456` vs `snapshots.ts:114`). Take a snapshot of the current tree before restoring, so a restore can be undone.
10. Keep the `st` contracts: `st service wait` exits as before (1 while running; the job's real exit code on failure), and `st logs -l WARN` shows only that level.
11. **Deploy code runs from the working tree.** The detached job and `aico deploy` run the ops bundle from the installed release (or the exported sha), never from uncommitted sources in the checkout.

Snapshot retention moves to M10c-2 with the backups engine; leave SummitFlow's timer.

Proof: the tests above; `st check --quick --changed-only`. Deploy through `st service rebuild aico --detach` itself (check `st lease --list --all` first), and `nightshift declare` if anything on the host changes. Live:
- a deploy succeeds;
- `aico vm list` and `status` work through the API path;
- `st service wait` gives the old exit codes;
- a rebuild with `--with-ack` under a test hold passes acceptance (take the hold from a second identity, e.g. `AGENT_ID=test-holder`, and release it).

Rules: commit with `st commit -m "..." --paths <files>` in plain words, ending with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Hold leases; M10b-1 (packages/checks) and M9-1 (packages/webtools, context) run at the same time. Never git stash, reset, checkout or rebase. Never open the neri repo or Neri data, or read credentials (the Proxmox token stays where SummitFlow reads it). Never start or stop the owner's VMs; VM 180 stays off.

Report (≤15 lines): commits, each item, tests, live checks.
