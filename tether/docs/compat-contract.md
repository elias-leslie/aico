# Compatibility contract

Tether takes over a running system. Every name below is depended on by Aico, A-Term, SummitFlow, codex sync, operator scripts, or durable state that already exists. Each item was checked against Aico at `dfe73a3` and A-Term's current `main`.

Renaming `AICO_*` across other repos is out of scope. A change to anything in this file is a breaking change and needs an ADR.

## Instances

Only the `default` instance keeps the Aico names, serves the legacy sockets and adopts historical servers.

Every other instance:

- puts its name into its unit names, exit-marker directory, state directory and socket;
- never reconciles another instance's units (`ownsTmuxServerUnit` in `src/config.ts`).

## systemd units and cgroups

| Contract | `default` | Instance `<i>` | Aico source |
| --- | --- | --- | --- |
| tmux server unit, new | `aico-tmux-server-<id>.service` | `tether-<i>-tmux-server-<id>.service` | `ownership.ts` `durableTmuxServerUnit` |
| tmux server unit, historical | `aico-tmux-server-<id>.scope`, kept as read-only identity evidence | none | `ownership.ts` `AICO_TMUX_SERVER_UNIT_RE` |
| Server generation id | 8–64 lowercase hex; new ones are 32 hex (16 random bytes) | same | `index.ts` `provisionManagedServerWithSession` |
| Slice | `app.slice`; the exact control group is `/user.slice/user-<uid>.slice/user@<uid>.service/app.slice/<unit>` | same | `ownership.ts` `isOwnedTmuxServerControlGroup` |
| Pane scope | `tmux-spawn-<uuid>.scope` under `app.slice` with an exact control-group match | same | `ownership.ts` `TMUX_SCOPE_RE`, `isOwnedPaneControlGroup` |
| Pane memory policy | Owned by Nightshift, not Tether: `DefaultOOMPolicy=continue` and the per-pane cap in `~/.config/systemd/user/tmux-spawn-.scope.d/40-nightshift-pane.conf`, both installed by Nightshift's `deploy/systemd/install.sh`. A kernel OOM kill then takes one process and the pane keeps running. Tether installs no pane drop-in; `tether doctor` warns when a live pane is not on `OOMPolicy=continue` or has no finite `MemoryMax`. The pane supervisor sets its own OOM score adjust to 100 before starting the agent and restores the inherited value for the fallback shell (`launch.ts` `paneCommand`), so under the cap the kernel kills a large tool at the inherited 200 before the agent. If the write fails the agent still starts, at the inherited value. The focused pane gets `MemoryLow=2G` at runtime (`pane-memory.ts`). | same | Nightshift host drop-in |
| Daemon unit | `tether@default.service` (replaces `aico-owner.service` in Phase 5) | `tether@<i>.service` | n/a |

The `systemd-run` flags are part of the containment model and must be kept: `--user --quiet --collect --slice=app.slice --service-type=exec --expand-environment=no -p ExitType=cgroup`, null stdin, and journal stdout/stderr (`ownership.ts` `durableTmuxServerArgs`).

## Filesystem and sockets

| Contract | `default` | Instance `<i>` | Aico source |
| --- | --- | --- | --- |
| tmux server socket | `<state>/tmux/<id>/server.sock`; dirs 0700 | same | `index.ts` `createManagedServerDirectory` |
| Imported server sockets | `~/.local/state/aico/tmux/<id>/server.sock`. Rows keep their absolute `socket_path` and are never moved. Every imported row is now `phase = 'dead'` with no session bound to it; Tether never opens or stats a dead row's socket or directory, so the Aico dirs may be deleted and the rows stay as history. | none | `store.ts` `tmux_servers.socket_path` |
| Historical shared socket | `/tmp/tmux-<uid>/aico`, adopted read-only and never respawned | none | `tmux.ts` `resolveInternalTmuxSocket` |
| Pane-exit marker | `/run/user/<uid>/aico/pane-exited-<serverId>` | `$XDG_RUNTIME_DIR/tether/<i>/pane-exits/pane-exited-<serverId>` | `tmux.ts` `paneExitedEventPath` |
| Pane-exit hook bytes | `set-hook -g pane-exited 'run-shell "/usr/bin/touch <marker>"'`, compared byte for byte before every launch | same form | `tmux.ts` `paneExitedHookCommand` |
| Legacy owner socket | `/run/user/<uid>/aico/control.sock`, serving exactly `GET /v1/sessions/<widgetId>` and `POST /v1/sessions/<widgetId>/end {generation}` with Aico's response bodies | none | `owner-control.ts` |
| Legacy GUI socket | `/run/user/<uid>/aico/gui-control.sock` shim, serving `/v1/roots*` and `/v1/widgets*` with Aico's bodies and forwarding view mutations to the GUI channel | none | `root-control.ts` `guiSocketPath`, [root-control.md](root-control.md) |
| Tether socket | `$XDG_RUNTIME_DIR/tether/default/control.sock` | `$XDG_RUNTIME_DIR/tether/<i>/control.sock` | n/a |
| State | `~/.local/state/tether/default/tether.db` | `~/.local/state/tether/<i>/tether.db` | n/a |
| Aico catalog | `~/.local/state/aico/aico.db`. Aico keeps its own views and settings there; its pre-Tether tables stay as a backup after import. No other app reads it: A-Term dropped its read-only reader (`A_TERM_AICO_STATE_DIR` in `utils/tmux/external.py`) when it moved to the Tether API (A-Term `e4d1f16`), and `tether import-aico` reads only the path given with `--from`. | none | none |

Overrides that the Aico process honours and that Tether must not break: `AICO_STATE_DIR`, `AICO_TMUX_SOCKET` (a test or recovery override of the historical socket), `AICO_CONTROL_SOCKET`, `AICO_GUI_CONTROL_SOCKET`.

## tmux identity

| Contract | Value | Aico source |
| --- | --- | --- |
| Session name | `aico-<widgetId>`. `widgetIdFromSession` and A-Term discovery parse it. | `tmux.ts` `sessionName` |
| Stable targets | `$<n>` session id and `%<n>` pane id; one pane per session, and extra panes fail closed | `store.ts` |
| Server global environment | exactly `AICO_OWNER=aico`, `AICO_WORKLOAD_CLASS=durable-tmux-server`, `AICO_TMUX_SERVER_ID=<id>`. These authenticate a zero-session server. | `tmux.ts` `matchesServerIdentityEnvironment` |
| Profile | `history-limit 200000`, `mouse off`, `focus-events on`, `status off` (the resize claim requires it), `default-terminal tmux-256color`, `terminal-overrides ,xterm-256color:Tc`, `terminal-features xterm*:sync`, `NO_COLOR` unset, `COLORTERM truecolor`, `CLICOLOR 1` | `tmux.ts` `tmuxConf` |

## Pane environment markers

Set on every pane Tether creates (`src/markers.ts`):

| Variable | Value | Verified in Aico |
| --- | --- | --- |
| `AICO_OWNER` | `aico`, on every session including A-Term-created ones, because codex sync requires it | `ownership.ts` `ownershipEnvironment` |
| `AICO_WORKLOAD_CLASS` | `durable-session` (`durable-tmux-server` on the server, `session-owner` on the daemon) | `ownership.ts`, `aico-owner.service` |
| `AICO_WIDGET_ID` | Session id (8 hex) | `ownership.ts` |
| `AICO_SESSION_ID` | ownership id (`aico-widget-<id>`) | `ownership.ts` |
| `AICO_TMUX_SERVER_ID` | Server generation | `index.ts` (`new-session -e`) |
| `AICO_PROJECT_ID` | project id, or empty | `ownership.ts` |
| `AICO_AGENT_SLUG` | Canonical tool slug | `ownership.ts` |
| `AICO_LIFECYCLE_VERSION` | `1` | `ownership.ts` `MANAGED_LIFECYCLE_VERSION` |
| `ST_SESSION_ID` | Root logical session id (roots only) | `root-launch.ts` |
| `AICO_ROOT_INITIAL_LAUNCH` | `1` or `0` (roots only) | `root-launch.ts` |
| `AICO_ROOT_INITIAL_PROMPT` | Transient prompt (roots only). It is unset again in the agent's own environment. | `root-launch.ts` |
| `AICO_ROOT_RESUME_SESSION_ID` | Native resume UUID or empty (roots only) | `root-launch.ts` |
| `A_TERM_SESSION_ID` | A-Term session UUID, only when A-Term created the session | A-Term `agent_service.py`, `root_workloads.py` |

Correction to the migration plan: `AICO_TMUX_SOCKET` is not a pane marker. Aico never sets it in panes; a live Aico pane today carries no such variable. Aico reads it as a process override of its internal socket (`tmux.ts`), so exporting it into panes would redirect any Aico started from a session. Tether does not set it. Panes find their server through tmux's own `TMUX` variable.

## Environment hygiene

- A tmux server's process environment becomes the tmux global environment, so it reaches every pane.
- Tether starts each server from an allow-list (`src/env.ts` `tmuxServerEnvironment`): `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, locale, `XDG_*`, display/DBus/SSH-agent variables and `TZ`/editor/pager.
- Operators can add exact names with `TETHER_ENV_PASSTHROUGH`.
- The three server identity markers are always added.
- The environment is applied through `/usr/bin/env -i` inside the `systemd-run` argv, because a transient service otherwise inherits the whole user-manager environment.
- A-Term's `FILTERED_ENV_VARS` (a superset is kept in `src/env.ts`) is removed from every server and session environment, even when allow-listed.
- `TMUX`, `TMUX_PANE`, `TMUX_TMPDIR` and `NO_COLOR` are always dropped.
- No app's `.env` file is ever read.

## Catalog data

- `tmux_servers` and `root_requests` keep Aico's columns, types, defaults and CHECK constraints (`src/schema.ts`). The widenings: managed `scope_unit` also admits `tether-<i>-tmux-server-<id>.service`, and schema v3 appends `root_requests.origin` (`aico` or `a-term`, default `aico`) after Aico's columns.
- `sessions` keeps the identity columns of Aico's `widgets` table with identical names. View columns (`x`, `y`, `width`, `height`, `display_id`, `open`) stay in Aico. `external_tmux_*` rows are not imported.
- `generation` is computed exactly as Aico's `sessionGeneration`: the JSON array `[id, sessionId, externalTmuxSocket=null, externalTmuxSession=null, {11 ownership fields in Aico's key order}]`. `src/generation.test.ts` pins a vector computed with Aico's own function. A generation read from Aico before cutover therefore stays valid against the imported row.
- Session ids are never reused: allocation checks `sessions.id` and `root_requests.widget_id`, as Aico does, plus `retired_session_ids` (schema v2), which a trigger fills when a session row is deleted.
- `tether import-aico --from PATH` (an explicit path is required; there is no default, because the live `aico.db` drops its pre-Tether tables after archiving) copies every `tmux_servers` row, every `root_requests` row (including tombstones) and the identity columns of every internal widget, in one transaction. It skips `external` widgets, opens `aico.db` read-only, is a dry run unless `--apply`, refuses `--apply` while the instance's daemon is listening, and is idempotent: identical rows are `same`, rows Tether has changed since are `kept`, never overwritten.

## Wire contracts

- `owner: "aico"` stays in every body served on the legacy sockets (`control.sock`, `gui-control.sock`) and in widget descriptors, for `st aico` and SummitFlow fleet. On Tether's own `/v1` socket a root's `owner` is its stored `origin` (`aico` or `a-term`) and the descriptor adds `origin`.
- Aico's `contracts/view-mutation-vectors.json` pins the title, bounds and body validation rules. Tether carries it in `contracts/` and both the Vitest and pytest suites run every vector.
- Error codes from Aico's owner and root routes are kept verbatim: `not_found`, `invalid_body`, `invalid_generation`, `stale_generation`, `busy`, `blocked`, `workload_unavailable`, `ended`, `gui_unavailable`, `request_conflict`, `outcome_uncertain`, `directed_delivery_unavailable`, `identity_changed`.
- Agent admission follows Nightshift's `$XDG_RUNTIME_DIR/nightshift/admission.json` (v1) while it is fresh: `admit: false` defers, `admit: true` replaces the thresholds below; missing, unparsable or expired state falls back to them. Agent admission env names are kept as `AICO_AGENT_MAX_ACTIVE`, `AICO_AGENT_MIN_AVAILABLE_GIB`, `AICO_AGENT_MAX_PSI_SOME_AVG60`, `AICO_AGENT_MAX_PSI_FULL_AVG60`, `AICO_AGENT_MAX_PSI_FULL_AVG10` and `AICO_AGENT_ADMISSION_OVERRIDE`.

## Host prerequisites

- `Linger=yes`. Durable work is refused without it.
- systemd 254 or later.
- Unified cgroup v2.
- `/usr/bin/tmux`.
- Node 22.13 or later (`node:sqlite`).

`tether doctor` and `scripts/install.sh` check all of these.
