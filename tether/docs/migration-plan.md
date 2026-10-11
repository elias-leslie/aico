# Tether migration plan

Tether is a standalone per-user session daemon. It owns tmux session lifecycle for Aico (desktop) and A-Term (web/mobile). Either app works alone against Tether; both can share one instance (`default`) or use separate instances.

## Owner decisions (2026-10-10)
- Name: **Tether**. Repo `/srv/workspaces/projects/tether`, unit `tether@<instance>.service`, CLI `tether`.
- Live cutover: allowed once the lifecycle harness, smoke tests and a separate test instance all pass. Back up `aico.db` first. If anything fails, roll back to the old Aico and stop.
- Postgres: after a verified `pg_dump`, drop `a_term_*` and `agent_tools` from the summitflow DB.
- Publishing: push commits to the existing repos; create a **public** GitHub repo `elias-leslie/tether`. Make **no** tags or releases.
- Projects: sourced from SummitFlow (`GET http://127.0.0.1:8001/api/projects`, loopback, no token) when installed, else a local folder list.
- Notes, prompts and recordings are removed from A-Term. Keep the Agent Hub prompt *cleaner*.
- Desktop auto-resize when the active client changes is desired behavior; keep it.

## Target shape
- **Tether** owns:
  - tmux server, session and pane lifecycle and containment (Aico's hardened model)
  - session catalog and create-request receipts (tombstones)
  - merged agent-tool registry
  - TUI launch, context-hook verification and agent admission
  - text injection
  - project list
  - event stream
  - active-client resize claim
  - `/v1/roots`

  It has its own SQLite DB (`node:sqlite`) and a versioned API over a 0600 Unix socket. It is never network-exposed.
- **Apps** keep their own byte path (PTY running `tmux attach -S <socket>`) and their own view state:
  - Aico: windows, settings, selections.
  - A-Term: panes, layouts and per-project display settings, in a small local SQLite file keyed by Tether session IDs.
- A dead session is never silently resurrected; starting a new one is an explicit action.

## Phase 0: contract
1. Tether gets its own `project.identity.json`. It is not a worker of either app, so rebuilding an app never restarts Tether. It ships as a self-contained build or vendored Node at a start path that stays stable across releases.
2. API v1 covers:
   - sessions: create, list, get, end, respawn, load-tui, switch-project, rename
   - attach target, capture/scrollback, inject
   - agent tools, projects
   - active-client resize claim
   - `/v1/roots` (create, show, position, title) with generation fencing and tombstones
   - events, health/version
3. Show, position and title are forwarded to a connected Aico GUI client. With none connected, Tether returns `gui_unavailable`; it never starts the desktop.
4. Compatibility contract:
   - Keep unit names `aico-tmux-server-<id>.service`, the socket layout `<state>/tmux/<id>/server.sock`, and the pane-exit marker dir `/run/user/<uid>/aico`.
   - Keep the legacy `/run/user/<uid>/aico/control.sock`, and a `gui-control.sock` shim.
   - Keep these pane env markers: `AICO_WIDGET_ID`, `AICO_SESSION_ID`, `AICO_TMUX_SERVER_ID`, `AICO_TMUX_SOCKET`, `AICO_PROJECT_ID`, `AICO_AGENT_SLUG`, `AICO_WORKLOAD_CLASS`, `AICO_LIFECYCLE_VERSION=1`, `AICO_ROOT_*`, `ST_SESSION_ID`.
   - Set `AICO_OWNER=aico` on every session, because codex sync requires it.
   - Sessions created from A-Term also get `A_TERM_SESSION_ID`.
   - Renaming `AICO_*` across other repos is out of scope.
5. Multi-instance: only `default` serves the legacy sockets and adopts historical servers. Other instances put the instance name into unit names, the exit-marker dir and the state dir, and never reconcile another instance's units.
6. Environment hygiene: tmux servers start with an allow-listed environment, and A-Term's `FILTERED_ENV_VARS` applies to every session. Never load an app's `.env`.
7. Merged tool registry: Aico `tui/tuis/*` plus A-Term rows (claude, codex default, agy, pi) plus shell. Editing it from A-Term changes Aico launches too.
8. Security:
   - The socket is 0600.
   - A-Term routes that reach Tether keep A-Term auth. Never gate them on loopback, because proxied traffic arrives from loopback.
   - `/api/internal/*` keeps its bearer token.
9. Write an ADR plus `CONTEXT.md` (Tether owns Sessions; apps own Views; the cross-app Owner concept is dropped).
10. Backups: `~/.local/state` is covered by btrbk. Record whether T7/Drive coverage includes it.

## Phase 1: A-Term cleanup (independent)
- Remove notes/prompts in the backend, frontend and `packages/notes-ui`, including the SummitFlow notes proxy.
- Remove recordings.
- Set `SUMMITFLOW_API_BASE` (companion mode) so A-Term stops writing SummitFlow `projects`.
- Delete about 85 stale `/tmp/tmux-1000/a-term-root-test-*` sockets after confirming no live server uses them, and fix the leaking test teardown.
- Update `CHANGELOG.md` and the docs.

## Phase 2: Tether skeleton
- Repo, CI, `st check` integration, systemd template unit, idempotent installer (checks linger, systemd 254+, cgroup v2).
- CLI subcommands: `sessions`, `roots`, `tools`, `projects`, `doctor`.
- Schema: `tmux_servers`, `sessions`, `root_requests`, `agent_tools`, `schema_version`. WAL, single writer.
- Project provider: SummitFlow with cache, falling back to local.
- Events and health. Instance parameterization everywhere. Keep the `tmux-spawn-*.scope` memory guard.

## Phase 3: Aico switches to Tether (built in parallel, one-step cutover)
- Move the lifecycle modules, their tests and their scripts from Aico into Tether. The list is in the Aico inventory (`docs/inventory-aico.md`).
- Rewire Aico IPC to call Tether.
- Split the store: Aico keeps `views` and `settings`; pin IDs are migrated.
- Preserve every invariant from `INCIDENT-2026-07-PROCESS-ESCAPES.md` and `CONTEXT.md`.
- Importer: an idempotent single transaction of `tmux_servers` (all rows), `root_requests`, and widget identity columns. Skip `external` rows. Keep `aico.db` as a backup.
- Keep A-Term discovery working: switch A-Term's `external.py` from `aico.db` to the Tether API in the same step, or mirror the data.
- Cutover from a non-Aico terminal context: stop the GUI and `aico-owner`, import, start Tether, start the new Aico. Re-verify live sessions.

### Phase 3a: Tether is a complete session owner (done)
- Lifecycle extracted into `src/lifecycle/`, every v1 route implemented, invariants pinned in `src/lifecycle/invariants.test.ts`, `tether import-aico` written and run against a copy of the live `aico.db`.
- Proven on `tether@dev` with `scripts/tether-lifecycle-harness.sh` and `scripts/tether-real-session-smoke.sh` ([LIFECYCLE_HARNESS.md](LIFECYCLE_HARNESS.md)).

### Phase 3b: Aico becomes a client
- Aico's main process stops provisioning tmux servers and scopes, and stops serving `control.sock` and `gui-control.sock`; `tether@default` serves both with Aico's wire format.
- Session create, End, respawn, load-TUI, switch-project, rename, diagnostics, capture, scrollback and inject call the v1 API. Attach uses `GET /v1/sessions/:id/attach` (`argv`, `env` overrides, `unset`).
- The GUI opens `GET /v1/gui/channel` (`x-tether-client: aico-gui`), applies `show`/`position`/`title` through its existing `widgetMutationOperation`, and answers `POST /v1/gui/results/:commandId`.
- Aico keeps only view state (`x`, `y`, `width`, `height`, `display_id`, `open`, pins) and settings, keyed by session ID. It follows `session.*` events.

### Cutover (one step, from a terminal outside Aico's tmux servers)
1. Stop `aico-shell` and `aico-owner`. tmux server units keep running; they are their own transient services.
2. Back up `aico.db` with SQLite's online backup or `VACUUM INTO`, never `cp` of a live WAL database.
3. `tether import-aico` and review the dry-run diff, then `tether import-aico --apply` (it refuses while `tether@default` is listening).
4. `scripts/install.sh --start default`. Startup reconciliation adopts the imported `aico-tmux-server-*` units and the historical `/tmp/tmux-<uid>/aico` server; `/run/user/<uid>/aico/{control,gui-control}.sock` are served again.
5. Verify: `tether sessions` lists every live session as `running` with the generation Aico reported; `st aico` and SummitFlow fleet answer through the legacy sockets; `GET /v1/health` reports `lifecycle: "ready"`.
6. Start the Phase 3b Aico and confirm `gui.connected` is true.
7. Rollback: stop `tether@default`, then start the old `aico-owner` and `aico-shell`. `aico.db` was never written, and no tmux server is stopped by stopping the daemon.

## Phase 4: A-Term becomes a client
- Delegate lifecycle, sessions, agent tools, roots, broker and projects to Tether. Keep `/v1/roots` as a proxy until SummitFlow moves.
- New sessions go on private servers (`-S`).
- Existing default-server sessions are attach-only legacy until they end. Remove the global hook with `set-hook -gu client-session-changed`.
- Resize: claim only when the view becomes active.
- `tclaude`/`tsession`: handle "inside a different tmux server", since `switch-client` cannot cross servers.
- Data:
  - Move panes (36) and project settings (12) to local SQLite.
  - Merge `agent_tools` into Tether.
  - Mark the stale alive row dead.
- Drop Postgres code, deps, install steps and CI. `/health` checks Tether instead.
- Rewrite tests against a fake Tether.

## Phase 5: remove federation; update consumers
- Aico and A-Term federation code.
- SummitFlow:
  - fleet surfaces → Tether, mapping old surface values
  - `aico_session_observation`
  - the `st aico` extension and tool registry
  - docs, service constants, `logs_config`, `smoke_test`, `db_workbench_targets`
  - `tmux-agent-session-sync`: retired (cutover log section 5)
- Agent Hub: `db.sh`.
- Host:
  - add `tether@default`
  - remove `aico-owner`
  - `a-term-backend` depends on Tether
  - update desktop entries
  - keep `~/.tmux.conf` as a dotfile

## Phase 6: decommission
- `pg_dump`, then drop the A-Term tables.
- Remove the hook-token, the `aico-owner` units and the legacy shims once unused.
- Archive `aico.db`.

## Phase 7: docs and push
- Update the docs in all repos and the portfolio write-ups.
- Versions: Tether v0.1.0; Aico and A-Term declare the minimum Tether API they need.
- Push. No releases.

## Cross-cutting checks
- Installs: Aico-only, A-Term-only, shared, and separate instances.
- End, rename and resize from either app.
- Restarts of Tether, each app, and a reboot with live sessions.
