# Changelog

## Unreleased

### Breaking: A-Term now requires Tether

Requires Tether API v1. Install and start Tether (`tether@default`) before A-Term.

- Sessions are owned by [Tether](https://github.com/elias-leslie/tether), the local session daemon (API version 1 or newer, `tether@default.service`). A-Term creates sessions through Tether with `origin: a-term`, attaches with Tether's exact `tmux -S <socket> attach-session` target, and ends, renames, respawns and switches tools through Tether. The same sessions appear in Aico, and Aico's sessions appear here.
- Postgres is gone from the runtime. A-Term keeps only view state (panes, layout, which session each pane shows, project display settings) in `~/.local/state/a-term/a-term.db`. `DATABASE_URL`, the `DB_POOL_*` settings, Alembic, `managed-postgres.sh` and the installer's database steps are removed. The installer now checks for Tether instead.
- New `a-term migrate-from-postgres` (dry run by default, `--apply` to write) copies panes, layouts, project settings and links to still-running pre-Tether sessions from the old tables, reading Postgres only. It needs the new `migrate` extra. `a-term import-tools` adds the old agent tools to Tether's registry in one transaction (Tether's `POST /v1/tools/import`, dry run unless `--apply`). See `docs/cutover-a-term.md`.
- Agent tools are Tether's shared registry. Claude Code's slug is `claude-code`; `claude` remains an alias. Tool edits change launches in Aico too.
- Projects come from Tether (SummitFlow's catalog when installed, else Tether's local list). `SUMMITFLOW_API_BASE` is removed; registering a project goes through Tether's `POST /v1/projects` and is off when SummitFlow supplies the projects.
- Resizing: a view claims the shared window size through Tether only when it becomes active; dragging resizes only that view's own client. A refused claim is retried briefly only for Tether's retryable reasons (`client_not_attached`, `tmux_unavailable`; `stale` re-reads the generation once).
- `/v1/roots` stays on A-Term's service for SummitFlow's `a-term` surface but forwards to Tether's root contract with `origin: "a-term"`, so Tether stores the origin, reports `owner: "a-term"` and lists only A-Term's roots here. `title` is Tether's; `show` is applied by A-Term; `position` is unavailable as before.
- Removed the Aico federation: Aico tmux catalog discovery, `A_TERM_AICO_STATE_DIR`, the Aico control-socket close path, `POST /api/internal/sessions/{id}/end` and the Aico resize verification. Removed the global tmux `client-session-changed` hook and `/api/internal/session-switch`; the backend removes the old hook from the default tmux server on start.
- `tsession`, `tclaude`, `tcodex` and the project launcher go through Tether and attach with `tether sessions attach`: inside the same Tether tmux server it switches the client, inside a different one it nests (with `TMUX` unset, after a notice). `--print` prints Tether's attach target. Terminal views start from A-Term's environment, set Tether's attach `env` overrides and remove its `unset` list. `tsession projects --format tsv` lists Tether's projects.
- Pre-Tether A-Term sessions still running on the default tmux server stay visible and attach-only until they end.
- `/health` reports Tether (with the API version check) and tmux instead of the database.
- Maintenance keeps its run history in memory instead of a table.

### Other changes

- Removed notes and the prompt library: the Notes panel and `/notes` page, the `/api/notes` routes and SummitFlow notes proxy, note storage, and the `packages/notes-ui` workspace package. Agent Hub prompt cleaning is unchanged. Existing `a_term_notes*` tables are left in place for a later dump-and-drop.
- Removed session recording: the JSONL recorder, the `/api/diagnostics/recordings` routes, and the `RECORDING_*` settings. Per-session diagnostics remain. Existing recording files under the cache directory are no longer read or written.
- The root-launch tmux test now removes its private `-L` socket file after killing the server, so test runs no longer leave `a-term-root-test-*` sockets in the tmux socket directory.

## 0.2.11 - 2026-05-14

- Matched TUI scrollback overlays to the live xterm WebGL renderer so entering scrollback no longer changes font spacing, wrap points, or terminal columns.
- Kept desktop scrollback overlays on desktop scrollbar styling while preserving the wider mobile touch scrollbar only for mobile devices.
- Added renderer-status diagnostics for live terminals so WebGL/DOM fallback state can be confirmed from backend logs when rendering issues appear.

## 0.2.10 - 2026-05-10

- Switched the xterm renderer to WebGL (`@xterm/addon-webgl`) with automatic DOM fallback on context loss, dramatically reducing redraw cost for heavy TUI sessions like Claude Code and Codex CLI.
- Split the resize debounce into two stages so xterm fits to the container on a fast 16ms tick while the backend PTY resize message only fires on a trailing 250ms quiet — eliminates SIGWINCH storms and prompt flicker during window drags.
- Gated the scrollback overlay's per-delta search-version bump behind active consumers (overlay open or query in flight), so scrollback updates no longer force a parent re-render of the terminal component on every server delta.

## 0.2.9 - 2026-05-02

- Added a pane overflow menu `Refresh Layout` action that remounts the pane terminal and re-runs viewport sizing without restarting the tmux session.
- Fixed detached-window attach/re-attach behavior so unowned detached panes stay attachable from any window instead of getting stranded by stale URL pane scope.
- Fixed browser speech-to-text transcript merging so cumulative interim/final chunks no longer duplicate dictated words.
- Tightened mobile keyboard viewport sizing so the bottom keyboard/action row remains inside the visible viewport when the native keyboard changes screen height.

## 0.2.8 - 2026-04-22

- Fixed the mobile pane switcher so project panes no longer show duplicate shell and Hermes rows just because one pane owns both sessions.
- Fixed same-pane project switching so reusing an existing target pane preserves that pane's own active workflow state more reliably.
- Suppressed stale tmux scrollback warning spam so long-running TUI sessions stop emitting noisy false-positive history warnings.
- Hard-stopped frontend systemd restarts when the a-term Next.js process exits so restart loops fail fast instead of silently churning.

## 0.2.7 - 2026-04-21

- Fixed same-pane pane/project switching and 3-pane layout behavior so project swaps preserve the active workflow more reliably.
- Fixed browser voice transcription fallback so re-delivered finalized phrases no longer duplicate dictated words.
- Fixed scrollback overlay freshness so the newest live tail wins even when the latest page is shorter than cached history.
- Reserved the TUI overlay scrollbar rail up front so opening agent/TUI scrollback no longer steals columns and shoves text sideways.

## 0.2.6 - 2026-04-18

- Added Hermes as a built-in agent tool preset across mode switching, Settings, and external tmux session detection.
- Hardened the Hermes/TUI prompt workflow: prompt cleaning now has stronger diff/refinement/edit coverage and graceful fallback to the original prompt when the cleaner errors.
- Fixed the Hermes scrollback overlay regression so history entry still anchors at the live bottom output before you scroll backward.
- Excluded frontend build artifacts from Python sdists so release bundles stay clean.
- Documented built-in agent presets and the Agent Hub prompt-cleaning flow in the README.
- Bumped security-sensitive dependencies, including `python-multipart` to `0.0.26` and `mako` to `1.3.11`.

## 0.2.5 - 2026-04-15

- Detached panes now open into dedicated scoped windows, with `Close Pane` keeping the prior remove-from-layout behavior.
- Added same-pane project switching with mode carry-over so project swaps stay in the active tool mode instead of dropping back to plain shell.
- Fixed detached-window attach/reopen flow so panes no longer get stuck on `Open an A-Term` after attach/open actions.
- Restored a mobile-first session switcher model: one touch-friendly bottom sheet, global session visibility across attached and detached work, and no duplicate desktop-only header controls.
- Stopped stray ad-hoc panes from auto-spawning during temporary zero-pane transitions by verifying true global pane count before auto-create.
- Tightened overlay/mobile pane-selection scrolling so long switcher lists can be scrolled reliably on touch devices.

## 0.2.4 - 2026-04-10

- Added low-noise Dependabot coverage with monthly grouped updates and semver-major updates ignored by default.
- Updated frontend dependencies, including the Next.js security patch to 16.2.3.
- Fixed prompt preview line keys so the upgraded Biome gate passes cleanly without suppressions.
- Verified the public repo has no open Dependabot, CodeQL, or secret scanning alerts.

## 0.2.3 - 2026-04-10

- Refreshed the public README around A-Term's core strengths: persistent agent panes, file browsing, prompt-ready Notes, and release-oriented workflows.
- Replaced the main README screenshots with real captures from the running A-Term app, including clean 5-pane and 4-pane layouts.
- Normalized saved pane group sizes so stale layout ratios no longer leave gaps in restored multi-pane grids.
- Added public-release polish for README badges, contributor credit, CI visibility, CodeQL, Dependabot, and repository security posture.

## 0.2.2 - 2026-04-10

- Prepared the first public release baseline after the Terminal to A-Term rename.
- Hardened public repository scans and identity manifest path handling.
- Clarified release metadata, contributor credit, and installation documentation.
