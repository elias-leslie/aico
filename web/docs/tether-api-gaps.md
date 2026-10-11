# Tether API gaps found while moving A-Term onto Tether

A-Term is written against Tether's `docs/api-v1.md` as the contract. While
moving A-Term onto Tether, ten places came up where the contract did not cover
something A-Term needed. Tether closed them as additive v1 changes (marked
*(3a)* in its `docs/api-v1.md`; the API version stays 1). A-Term now uses
those routes and fields and has dropped its workarounds. Each entry below
records the gap, what Tether added, and what A-Term does now.

All of it was checked live against a running non-default instance
(`tether@dev`), with the branch backend on an alternate port.

## 1. `POST /v1/roots` could not say which app requested a root (resolved)

- Tether: `POST /v1/roots` accepts optional `origin` (`aico` or `a-term`) and
  `aTermSessionId` (a UUID, only with `a-term`). Both are stored and neither is
  part of the request digest. `aTermSessionId` becomes the pane's
  `A_TERM_SESSION_ID`.
- A-Term: `/v1/roots` forwards every create with `origin: "a-term"` and an
  `aTermSessionId` (a new UUID unless the caller sent one). A body naming
  another origin is refused with `400 invalid_body`.

## 2. Root descriptors carried no origin and the list had no filter (resolved)

- Tether: descriptors carry `origin`; `GET /v1/roots?origin=aico|a-term`
  filters (`400 invalid_query` for any other value).
- A-Term: the `a-term` surface lists `GET /v1/roots?origin=a-term`, so
  SummitFlow sees only roots requested through A-Term.

## 3. Root `owner` was always `"aico"` (resolved)

- Tether: on `/v1`, a root's `owner` is its stored origin. The legacy Aico
  sockets on the default instance still say `owner: "aico"` and carry no
  `origin`, so `st aico` is unaffected.
- A-Term: no longer rewrites `owner`. It only adds its `position` block
  (`browser_grid_has_no_pixel_window_bounds`) to descriptors.

## 4. Root `show`, `position` and `title` needed the Aico GUI (resolved for `title`)

- Tether: `title` with no GUI connected renames the session in the catalog
  under the lifecycle lock, fenced on the exact running generation, and
  publishes `session.updated`. With a GUI connected it still goes through the
  GUI and renames only if the GUI applies it. `show` and `position` still
  answer `503 gui_unavailable` without a GUI.
- A-Term: forwards `title` to Tether's root route and dropped its own label
  validation and `PATCH /v1/sessions` rename. `show` (bring the root's pane
  into the layout) and `position` (`503 position_unavailable`) stay with
  A-Term, because A-Term's views are browser panes, not Aico windows.

## 5. No bulk import for agent tools (resolved)

- Tether: `POST /v1/tools/import` `{tools (≤200), dryRun?, updateExisting?}`
  applies in one transaction and returns `{applied, created, updated,
  unchanged, differs: [{slug, fields}]}`. Any invalid entry rejects the batch
  with `400` and writes nothing.
- A-Term: `a-term import-tools FILE` sends the file to that route. It is a dry
  run (`dryRun: true`) unless `--apply`; `--update-existing` maps to
  `updateExisting`. Unset (`null`) fields are left out so they neither show as
  differences nor clear Tether's values.

## 6. No route to register a local project (resolved)

- Tether: `POST /v1/projects` `{id, root, name?}` appends to `projects.json`
  atomically in local mode and publishes `projects.changed`. It answers
  `409 projects_managed_by_summitflow` when SummitFlow supplies the projects,
  `409 project_exists`, `400 invalid_project_id` or `400 invalid_project_root`.
  `refresh=1` re-reads `projects.json` in local mode.
- A-Term: "Register project" calls that route. A root that is already listed
  returns that project; a taken id gets a numeric suffix (`-2`, `-3`, ...).
  A-Term no longer writes Tether's file.

## 7. `resize-claim` refusal reasons were not enumerated (resolved)

- Tether: `reason` is one of `client_not_attached`, `stale`,
  `tmux_unavailable` (retryable) or `window_linked`, `status_row`, `invalid`
  (permanent).
- A-Term: retries `client_not_attached` and `tmux_unavailable` at most 5 times,
  100 ms apart; re-reads the generation once on reason `stale` or
  `409 stale_generation`; stops at once on any other reason, including ones
  added later. A refused claim never affects the view's own PTY size.

## 8. Attach `env`: complete environment or overrides? (resolved)

- Tether: `env` holds overrides only (`TERM`, `COLORTERM`, `CLICOLOR`), and
  `unset` lists keys to remove (`TMUX`, `TMUX_PANE`, `TMUX_TMPDIR`,
  `NO_COLOR`). Both lists may grow.
- A-Term: a view's tmux client starts from A-Term's environment, sets Tether's
  `env`, then removes every key in `unset` plus its own baseline list (the same
  four keys, used for legacy and external attaches that get no list).

## 9. The Tether CLI could not create or attach sessions (resolved)

- Tether: `tether sessions create [--tool] [--project] [--name]` and
  `tether sessions attach <id> [--print]`. Attach applies the env contract,
  switches the client inside the same tmux server and nests with a notice
  inside a different one.
- A-Term: `tsession open --attach` (and `tclaude`, `tcodex`) still decide which
  session to use (reuse the project's session or create one through A-Term, so
  it shows in an A-Term pane) and then run `tether sessions attach <id>`.
  `--print` prints Tether's attach target. `TETHER_BIN` overrides the binary.
  `tether sessions create` is not used: it creates with `origin: "cli"` and no
  A-Term pane.

## 10. No import for root-request tombstones (no route needed)

A-Term's `a_term_root_requests` table was empty at cutover, so nothing was
lost. Tether keeps tombstones only through `tether import-aico`; there is no
separate tombstone import route, and A-Term needs none.

## Remaining notes

- Root `title` with an Aico GUI connected is applied by the GUI, so it depends
  on the GUI accepting a title for a root requested through A-Term. This
  behaves as Tether's contract specifies; it was not exercised live, because
  `tether@dev` had no GUI connected.
- The API version did not change for these additions, so `apiVersion >= 1`
  cannot tell an older Tether build from this one. The cutover runbook checks
  `GET /v1/roots?origin=a-term` instead.
