# Aico inventory for the Phase 3 extraction

This classifies Aico at `dfe73a3` (`electron/main/*`, `scripts/*`).

- **Move** means the module, its `*.test.ts` and its invariants move into Tether. Change only import paths and the instance parameters (unit names, marker directory, state directory).
- **Split** means part of the module moves.
- **Stay** means Aico keeps it as view or GUI code.

## electron/main

| Module | Fate | Notes |
| --- | --- | --- |
| `ownership.ts` | Move | Unit names and the control-group regex must become instance-aware (`src/config.ts` `tmuxServerUnit` / `ownsTmuxServerUnit`) |
| `tmux.ts` | Move | Argv builders. `TMUX_SOCKET` and `paneExitedEventPath` take paths from `TetherPaths`. |
| `tmux-server-state.ts` | Move | Server runtime classification |
| `procfs.ts` | Move | /proc and cgroup readers |
| `owner-scope.ts` | Move | Exact scope stop, `cgroup.kill`, inode identity |
| `owner-retirement.ts` | Move | End sequence. `sessionGeneration` already lives in `src/generation.ts`. |
| `owner-runtime.ts` | Replaced | By `engineRetirementOperations` in `engine.ts` (headless copy removed) |
| `owner-control.ts` | Move | Becomes the legacy `aico/control.sock` adapter on `default` |
| `owner-service.ts` | Replaced | By `src/daemon.ts` |
| `lifecycle-guard.ts` | Move | Lifecycle owner lock and gate-recovery decisions |
| `agent-admission.ts` | Move | PSI and memory admission. Keeps the `AICO_AGENT_*` env names. |
| `pane-exit-queue.ts` | Move | Marker watcher and reconciliation queue |
| `root-control.ts` | Split | The server side (create, get, tombstones, digest, validation, admin) moves. `widgetMutationOperation` runs in the GUI behind the GUI channel. |
| `root-launch.ts` | Move | Transient prompt env (`AICO_ROOT_*`, `ST_SESSION_ID`) |
| `scrollback-page.ts` | Move | Backs `/v1/sessions/:id/scrollback` |
| `interactive-tmux.ts` | Split | `activateTmuxViewSize` backs the resize claim. The coalescing helpers stay. |
| `terminal-env.ts` | Split | Tether returns the attach env; Aico's PTY applies it |
| `tui/spec.ts`, `tui/launch.ts`, `tui/context.ts`, `tui/detect.ts` | Move | The engine. Specs come from the `agent_tools` table. Resume adapters stay code, keyed by slug. |
| `tui/registry.ts`, `tui/tuis/*` | Replaced | By `agent_tools` seeds (`src/tools.ts`). Icons stay in Aico's renderer, keyed by slug. |
| `project.ts` | Split | Tether's provider replaces `st projects list`. The personal workspace (`__aico_personal_workspace__`) stays an Aico-side cwd choice. |
| `store.ts` | Split | `tmux_servers`, `root_requests` and widget identity columns move to Tether. `widgets` view columns and `settings` stay as Aico's `views`/`settings`. |
| `session-catalog.ts`, `external-view-reconciliation.ts` | Retire in Phase 5 | Cross-app federation (`external_tmux_*` rows) |
| `native-admin.ts` | Move with root admin | Fail-closed, content-free |
| `index.ts` | Split | Server provisioning, the launch gate, respawn, `loadTui`, `switchProject`, startup reconciliation and diagnostics move. Windows, IPC, tray and PTY stay and call Tether. |
| `arcade*`, `csp`, `media-permission`, `selection*`, `sidecar`, `tray`, `build-download`, `ipc-validation`, `activation-launcher` | Stay | GUI |

## Scripts and contracts

| Path | Fate |
| --- | --- |
| `scripts/aico-lifecycle-harness.sh`, `docs/LIFECYCLE_HARNESS.md` | Move; it must run against a test instance (`tether@dev`) |
| `scripts/aico-install-context-hooks.sh`, `scripts/tui-hooks/` | Move (context-hook verification is Tether's) |
| `scripts/aico-root-watch.py`, `scripts/tests/test_aico_root*.py`, `test_aico_create.py`, `test_aico_widget.py`, `test_aico_admin.py`, `test_view_mutation_contract.py` | Moved to Tether, which owns the root contract (post-cutover). `install.sh` installs the script to `~/.local/lib/tether/scripts/`; Aico's `scripts/aico-root-watch.py` stays as the `st aico` entry and execs that copy. |
| `contracts/view-mutation-vectors.json` | Copy into Tether; both suites run every vector |
| `scripts/systemd/aico-owner.service` | Remove in Phase 6, after `tether@default` replaces it |
| `scripts/aico-real-session-smoke.sh`, `scripts/scrollback-gate.sh` | Move or adapt as Tether smoke tests |

## Invariants that must survive (from CONTEXT.md and the incident report)

1. tmux servers are manager-spawned transient `.service` units with null stdin, `--expand-environment=no` and `ExitType=cgroup`. They never inherit the caller's descriptors.
2. Panes start as a bare no-RC gate. The TUI launches only after the exact `tmux-spawn-*.scope` control group and InvocationID are verified.
3. Persisted launch state is `gated` or `dispatched`. A dispatched gate is never replayed automatically after a crash.
4. Containment stops only the exact owned pane scope, with `cgroup.kill` as fallback and directory device/inode identity checks.
5. Lifecycle-v0 sessions are read-only. There is no broad kill and no forced migration.
6. The `pane-exited` hook marker is level-triggered evidence, verified byte for byte before each launch.
7. `Linger=yes` is required before creating durable work.
8. Every owner mutation names the generation it read, and a changed generation is never retried.
9. Root request ids are tombstones and never relaunch ended work.
