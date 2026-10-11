# Live cutover log, 2026-10-11

Owner-approved overnight cutover of Aico and A-Term onto Tether (parent task `task-c29cea5cc5ad44a5`).
Run by an agent from inside a live Aico tmux session, so the tmux server unit and pane scopes are checked after every step.

## 0. Pre-flight (no changes)

Git `main` heads:

| Repo | SHA |
| --- | --- |
| aico | `dfe73a30c76a8629c1994e5b1dad6f0341d53260` |
| a-term | `93357184f4fb6e4ba851f6509f8f1fb2d8683957` |
| tether | `7f3606cbb822a251489f2a975031defd83078660` |
| aico `tether-client` | `2a8b62c13b582f12fe31618ce66619417e7d8f28` (fast-forward of main) |
| a-term `tether-client` | `8420b03b1c0ce7bfab98f15ef1e296eea45693ca` (fast-forward of main) |

User units before:

```
aico-tmux-server-06e633492f792ad10439f675491801ee.service  active running
tmux-spawn-2da10df5-00c7-4384-87eb-65c65358111b.scope        active  (Aico pane, server pid 9900)
tmux-spawn-58c41890-666e-4af3-a352-920de0883987.scope        active  (Aico pane, server pid 9900)
tmux-spawn-58f3e8cb-08ee-4b68-a751-c1a6cde7f630.scope        active  (A-Term summitflow-70b339cd-...)
tmux-spawn-a2d13064-6195-40f1-843d-6bbcbb871d07.scope        active  (other tmux, pid 2857250)
tmux-spawn-abcced48-2ceb-48c6-80d0-cce331aeb31f.scope        active  (other tmux, pid 3801059)
aico-shell.service active; aico-owner.service active (unit file disabled); tether@dev active
a-term-backend.service, a-term-frontend.service active
```

Live Aico sessions (aico.db read-only, internal widgets; 0 external rows):

| widget | x | y | w | h | open | display | generation (st aico widget status) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| c69ee18f | 2352 | 32 | 925 | 1344 | 1 | 1 | `949a3356770f562800af5f828caf1654a70333ca9004f9efdcf76656c1f77c6a` running |
| 05e96622 | 924 | 32 | 1428 | 1344 | 1 | 1 | `79a77064584005de36163c341c36d38d3a07b4df6626eb06e64d614a4e22fe79` running |

`tmux_servers`: 69 rows, one `active` (`06e633492f792ad10439f675491801ee`, pid 9900); the historical `/tmp/tmux-1000/aico` row is `dead`. `root_requests`: 347 rows. Settings: `pins`, `terminal-font`, `arcade`.
`st aico roots` before: `{"owner":"aico","observation":"unavailable","reason":"root_limit"}` (pre-existing; the old owner refuses to list more than its root limit).

A-Term before: `/health` healthy (db ok, tmux ok; 2 DB sessions, 1 tmux session). Default tmux server has `summitflow-70b339cd-93a0-4898-8c4b-3d694ce8e8dc`; the global `client-session-changed` hook is set.
Tether: CLI at `~/.local/bin/tether`; `tether@default` not running; `tether@dev` running with 0 sessions.

### Tether preparation

- `tether --json version` now prints one JSON object only (`{cli, ...daemon /v1/version}`, or `{cli, daemon: null, error: "not_reachable"}` with exit 2 and the reason on stderr). Tether commit `be5d67c`. `st check --quick` in tether: ruff, types, pytest 255, biome, tsc, vitest 344, gitleaks all OK.
- `scripts/install.sh` installed the build to `~/.local/lib/tether` (prereqs: linger=yes, systemd 255, cgroup v2, tmux 3.4).
- `tether@dev` had 0 sessions (1 root tombstone from testing); stopped. It stays installed (unit still enabled).

## 1. Aico cutover

- Leases held on aico, a-term, tether (`tether cutover`).
- aico `main` fast-forwarded `dfe73a3` -> `2a8b62c` (tether-client). No dependency changes (package.json only drops the owner build scripts), so main's `node_modules`/`.venv` stay valid. `st check --quick` on aico main: ruff, types, pytest 429, biome, tsc, vitest 214, gitleaks OK.
- Stopped `aico-shell.service` and `aico-owner.service`. tmux server unit and all 5 `tmux-spawn-*` scopes unchanged; both `aico-*` sessions still on the server.
- Backup: `~/.local/state/aico/backups/aico-pre-tether-20261011-002607.db` (VACUUM INTO, mode 0600). `integrity_check` ok; 2 widgets, 71 tmux_servers, 347 root_requests. sha256 `9130a8ab...49f`.
- `tether import-aico` dry run: tmux_servers insert=71, sessions insert=2 (c69ee18f, 05e96622), root_requests insert=347; nothing unexpected. `--apply` imported the same; a second dry run reports all `same`.
- `scripts/install.sh --start default`: `tether@default` active, `lifecycle: ready` within 1 s, catalog sessions=2, tmuxServersActive=1, rootRequests=347. Both sessions `running` with the exact pre-cutover generations (Tether CLI and `st aico widget status` via the legacy `control.sock`). Legacy `control.sock` and `gui-control.sock` recreated. `st aico roots` answers the same `root_limit` as before. tmux units unchanged.
- `st service rebuild aico --detach`: the first job was refused by this session's own stale file leases on the aico-tether worktree; after `st lease --release-all` the second job (`f16409d1`) succeeded in 13 s: release `38124c32...` from source `2a8b62c`, `aico-shell.service` restarted, `aico-owner.service` not started (identity `default_workers: []`). The old release `b2e42fee...` stays as `previous` for rollback.
- New Aico: journal shows `[aico] copied 2 window views from the pre-Tether catalog` and `[aico:tether] connected at /run/user/1000/tether/default/control.sock`; no startup failure (the MESA dri warning predates the cutover). `/v1/health` `gui.connected: true`.
- Views: `views-migrated-from-widgets` set; both windows reopened (wmctrl: "Aico · Claude Code", "SummitFlow · Claude Code"). Geometry: 05e96622 `924,32 1428x1346` (was 1428x1344); c69ee18f `2348,32 929x1346` (was `2352,32 925x1344`, same right edge 3277). The 2-4 px difference is the window manager's adjustment written back after open, not a migration error. Pins rewritten without `tmux:` entries (none existed).
- Root lifecycle: `st aico create` fails before reaching Aico because `st` consumes `--project` as its own global flag (SummitFlow issue, unrelated to Tether). Ran the extension script it dispatches to (`scripts/aico-root-watch.py create`) directly: root `cutover-check-002800` -> session `267c0cf5` running; `st aico root status` running; `st aico root show` applied (an "Aico · Codex" window appeared); `st aico root end` applied, status `ended` tombstone, window closed.
- Throwaway shell session `5b281a76` (origin cli): paste-inject with submit delivered and executed (`cutover-inject-ok-42` in capture and scrollback), attach argv/env/unset as documented, rename kept the generation, pane carries the `AICO_*` markers and runs in its own `tmux-spawn-*.scope` under `app.slice`; `tether sessions end` ended it.
- `aico-owner.service` disabled (it was already disabled and stopped). tmux server unit and the 5 original pane scopes unchanged throughout.
- Aico docs: gap 4 marked closed (`docs/tether-api-gaps.md`) and the `aico-install.sh` comment updated; aico commit `c455c6f` (docs/comment only, no redeploy needed).

Not exercised: the tray "new widget", the End menu item and the window-close/reopen list need the active desktop, which this run had no authority to operate. Their Tether calls (create, end) were exercised through the API and sockets above.

## 2. A-Term cutover

- Preconditions: `tether@default` active, `tether doctor` all ok, `GET /v1/roots?origin=a-term` answers owner `a-term`. Pre-cutover a-term main `93357184`.
- a-term `main` fast-forwarded `9335718` -> `8420b03`; `uv sync --extra dev --extra migrate` in the checkout (the running backend ran from its release directory, so nothing live changed).
- `a-term migrate-from-postgres` dry run: source 36 panes, 12 project settings, 2 sessions, 4 tools. **Gotcha:** run from inside a tmux pane, the migration's tmux probe follows `$TMUX` to the wrong server and reported the live `summitflow-70b339cd...` session as `marked_dead`. With `TMUX`/`TMUX_PANE` unset it reports `legacy_link` (correct). Applied with `env -u TMUX -u TMUX_PANE`: inserted 36 panes, 12 project settings, 1 legacy link; `~/.local/state/a-term/a-term.db` and `tether-tools-import.json` are 0600. A rerun inserts 0.
- `a-term import-tools` dry run: created none; `differs` only for color/displayOrder on all four and `argv` on `pi`. Kept Tether's values (no `--apply`, no `--update-existing`).
- `st service rebuild a-term --detach`: first refused by local acceptance (`test_install_script_has_no_database_steps`: an ignored, pyc-only `alembic/` left in main's checkout after the merge deleted its sources). Removed that bytecode-only directory; next refused by this session's own repo hold; after releasing it, job `ead2217c` succeeded in 17 s (release `4796ed43...` from `8420b03`, backend and frontend restarted).
- Backend: `/health` `status: healthy`, `tether: {status: ok, apiVersion: 1}`, `db: null`. Journal: `legacy_session_switch_hook_removed: removed: True`; `tmux show-hooks -g` has no `client-session-changed[0]` entry. Unit already has `Wants=`/`After=tether@default.service` from the managed render, so `scripts/install.sh` was not needed.
- Layout: the old API listed only panes with live sessions, which was exactly one pane ("Ad-Hoc A-Term" with the legacy `summitflow-70b339cd...` shell). The new A-Term shows that same pane (legacy, attach-only). Startup maintenance pruned the 35 empty panes older than 7 days (`panes_pruned: 35`), none of which the old UI displayed. 12 project settings present.
- New project pane (`tether`, shell): session `727f4675` in `tether sessions` with origin `a-term`, `A_TERM_SESSION_ID` and `AICO_OWNER=aico` in the pane. Ended through Aico's legacy `control.sock` (`POST /v1/sessions/727f4675/end` with its generation); A-Term dropped it within 4 s.
- Launchers: `tsession projects --format tsv` lists Tether/SummitFlow projects; `tsession open --tool shell --project tether --attach --print` created a project pane through A-Term and printed Tether's attach target; `tcodex tether` outside tmux attached to the project's codex session in a temporary pty; `tclaude tether` with `TMUX` pointing at another server printed `tether: nesting inside the current tmux (/tmp/tmux-1000/default)` and attached nested. The same-server `switch-client` case was not run (it would retarget a live Aico window's client). All four throwaway sessions ended.
- SummitFlow `a-term` surface: root `aterm-cutover-check-003656` created through the `st aico` extension script with `--surface a-term` (owner `a-term`, session `5eaeb766`), `st aico root status/show --surface a-term` ok (pane added to the layout), `GET :8002/v1/roots` owner `a-term` with only `a-term` origins. `st aico root show` (Aico surface) opened it in Aico as a window.
- Mobile path: `https://terminal.summitflow.dev` answers 302 to the Cloudflare Access login (`summitflow.cloudflareaccess.com`), which loads (200). Sign-in and the phone checks need the owner. `st browser check http://localhost:3002` (isolated headless): readiness ready, 0 errors; the screenshot shows the legacy Ad-Hoc shell and the Tether root pane rendering live terminal content.
- A-Term agent tools come from Tether (`codex --yolo` default, `pi --approve`, shell); projects list has 33 entries from SummitFlow.

## 3. Close-out

- Cross-app, on the A-Term-origin root `5eaeb766`, shown in both apps:
  - Rename from Aico (`st aico root title`) and from A-Term (`--surface a-term`) each reached the Tether catalog, A-Term's session name and the Aico window title.
  - End from A-Term closed the Aico window.
  - End through Aico's socket removed A-Term's pane session (session `727f4675` above).
  - Resize claim: with the Aico window's tmux client (103x31) and a second client (140x40) attached, alternating `resize-claim` calls moved the window size to the claiming client each time (`applied: true`).
- Tether restart: with the two Aico sessions, one fresh A-Term session and the legacy A-Term pane live, ran `systemctl --user restart tether@default`. Result: `lifecycle: ready` and `gui.connected: true` within about 1 s, the same session ids and generations, and the tmux server unit and pane scopes unchanged. A-Term re-reconciled on the `gap` event; `/health` stayed healthy. Aico windows stayed attached. The test pane was then deleted through A-Term's API.
- Throwaway artifacts cleaned up: every test session ended; the test panes were deleted through A-Term's API. Root tombstones `cutover-check-002800` and `aterm-cutover-check-003656` remain by design.
- Tasks closed with validated acceptance: `task-faaf3e02c66d4a9a` (Aico 3b, source `c455c6f`) and `task-c5be1b534e1d43e4` (A-Term 4, source `8420b03`).
- Worktrees `aico-tether` and `a-term-tether` removed after confirming that each `tether-client` is an ancestor of its `main`. The symlinked `node_modules`/`.venv` were unlinked first; main's own copies are intact. Local `tether-client` branches deleted.
- Nothing pushed; Postgres untouched (read-only selects only).

Final state:

| Unit | State |
| --- | --- |
| `tether@default.service` | active, enabled |
| `tether@dev.service` | inactive (still enabled; starts empty at boot) |
| `aico-shell.service` | active (release `38124c32` from aico `2a8b62c`) |
| `aico-owner.service` | inactive, disabled (unit file kept for rollback until Phase 5) |
| `a-term-backend.service`, `a-term-frontend.service` | active (release `4796ed43` from a-term `8420b03`) |
| `aico-tmux-server-06e633492f792ad10439f675491801ee.service` | active, unchanged since before the cutover |
| 5 `tmux-spawn-*.scope` | the same 5 scopes as before |

Sessions: `c69ee18f` and `05e96622` running with their pre-cutover generations; A-Term legacy `summitflow-70b339cd...` attach-only.
Heads: aico `c455c6f`, a-term `8420b03`, tether `be5d67c` (plus this log).
Rollback assets: `~/.local/state/aico/backups/aico-pre-tether-20261011-002607.db`; old Aico release `b2e42fee...` (`previous`); A-Term pre-cutover `93357184`.

Residual issues:

1. `st aico create ... --project X` never reaches the extension: `st` consumes `--project` itself. Workaround: run `scripts/aico-root-watch.py create` directly. This is a SummitFlow fix and is unrelated to Tether.
2. `a-term migrate-from-postgres` probes tmux through `$TMUX`. Run it with `TMUX` unset. It was one-shot and is done.
3. `st aico roots` answers `root_limit` (pre-existing: 349 root requests including tombstones).
4. `tether sessions` can list a root as `uncertain` for a moment right after create, until launch verification lands (`GET /v1/sessions/:id` already said `running`).
5. Not exercised: Aico tray/menu actions (needs the active desktop), mobile sign-in and phone gestures (Cloudflare Access), and the same-server `switch-client` path of `tclaude`/`tcodex`.
