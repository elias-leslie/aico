# Tether API gaps seen from Aico

Aico became a Tether client on branch `tether-client`. These are the places where
Tether's API v1 did not cover what Aico used to do in-process, and what Aico does
instead. Most were closed by additive v1 changes after the live cutover
(2026-10-11); see Tether's `docs/api-v1.md` (*post-cutover* entries).

## Open

1. **Legacy sockets are default-instance only, and `st aico` ignores
   `TETHER_SOCKET`/`TETHER_INSTANCE`.** The `st aico` client (now in Tether,
   see 7 below) talks to `/run/user/<uid>/aico/{control,gui-control}.sock`,
   which only `tether@default` serves, so `st aico` cannot be pointed at
   `tether@dev` for testing. *Close it with:* either serve the legacy routes on
   every instance, or move the client to the `/v1` socket.
2. **The client still runs one tmux command besides `attach`.** Aico repaints
   its own attached clients (`list-clients` + `refresh-client` in
   `tmux-view.ts`) against the socket and target of its own attach argv. This is
   a view action on Aico's own clients, not a session query, and needs no Tether
   route.

## Closed after the cutover (Tether post-cutover API additions)

1. **Pane mode.** Tether serves `GET /v1/sessions/:id/pane-mode` and
   `GET /v1/legacy-sessions/:name/pane-mode`
   (`{alternateScreen, mouseReporting, historySize, inMode, mode}`). Aico used
   it for its attach-mode scrollback overlay; the overlay is gone (control mode
   is the default), so Aico no longer calls it.
2. **Context-hook status.** Every descriptor carries `contextHook`
   (`{state, detail, tool, applicable, checkedAt}`), changes publish
   `session.updated`, Tether re-checks running sessions after its own restart,
   and `POST /v1/sessions/:id/context-check` re-checks one session. Aico shows
   the titlebar badge from it again and asks for a re-check on window load, as it
   did before the cutover. A state of `unknown` (not checked yet) keeps the badge
   for the same tool and hides it for another tool.
3. **switch-project to the Personal Workspace.** `switch-project` accepts
   `{generation, projectRoot}`; Aico sends its Personal Workspace root that way.
4. **`tether --json version` was not pure JSON (closed in Tether `be5d67c`).**
   It prints one JSON object: the daemon's `/v1/version` fields plus `cli`, or
   `{cli, daemon: null, error: "not_reachable"}` with exit 2 and the reason on
   stderr when the daemon is down. `scripts/aico-install.sh` parses from the
   first `{` and greps for "not reachable", so it works with both outputs.
5. **Current project.** `GET /v1/projects` reports `activeProjectId` and a
   `current` flag per project from SummitFlow's active-project pointer
   (`st projects active`). Aico's picker marks it again.
6. **`st aico roots` answered `root_limit`.** The client lists with
   `GET /v1/roots?ended=0`, which leaves out the retained tombstones (349 at the
   cutover), and reads an exact request ID with `GET /v1/roots/:requestId`, so an
   ended root still reports its ended identity. Tombstones are kept.
7. **The root-watch script existed twice.** Tether owns it now, with the A-Term
   identity fix and every test (`test_aico_root_watch.py`, `test_aico_root.py`,
   `test_aico_create.py`, `test_aico_widget.py`, `test_aico_admin.py`,
   `test_view_mutation_contract.py`) and the view-mutation vectors. Tether's
   `scripts/install.sh` installs it to `~/.local/lib/tether/scripts/`. Aico's
   `scripts/aico-root-watch.py` is the path SummitFlow's tool registry runs; it
   execs Tether's installed copy (`TETHER_ROOT_WATCH` overrides the path).
8. **Legacy A-Term sessions had no events.** Tether publishes
   `legacy.changed {names}` when the legacy list changes (its own End, any list,
   and a 15 s poll while legacy sessions exist). Aico no longer lists, opens or
   attaches legacy sessions (none were left), so it ignores this event and the
   `/v1/legacy-sessions` routes.
9. **Events carried IDs only.** `session.created` and `session.updated` carry
   the descriptor as `session`; Aico applies it directly and re-lists only when
   an event has none (an older Tether), on `gap`, and on a daemon restart.
10. **New roots listed as `uncertain` for a moment.** `GET /v1/sessions` now
    verifies any session whose current generation was never verified, and a root
    create verifies before it answers, so the list agrees with a direct `GET`.

## Not applicable to Aico any more

- **Resize claim read `status` without `-A`.** The old Aico read the tmux
  `status` option with `show-options -t <session> -v status`, which prints an
  empty line when the option is only set globally. That code left Aico with the
  lifecycle; Tether's resize claim already uses `show-options -A`
  (`src/lifecycle/tmux.ts`).
- **Admission, context-hook installation, the lifecycle harness, the real-session
  smoke and the Codex admin qualification** all moved to Tether with the code
  they exercise.
