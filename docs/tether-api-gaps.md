# Tether API gaps seen from Aico

Aico became a Tether client on branch `tether-client`. These are the places where
Tether's API v1 did not cover what Aico used to do in-process, and what Aico does
instead. None of them blocks the cutover. Each one names the smallest Tether
change that would close it.

## Open

1. **No pane-mode route.** The renderer asks whether the pane is in copy mode
   (or another tmux mode) before it forwards wheel and keys. Tether has no route
   for this, so Aico runs a read-only `tmux display-message -p` against the same
   socket and target as its own attach argv (`tmux-view.ts`). It works because
   Aico and Tether run as the same user, but it is the only tmux command Aico
   still runs besides `attach` and the client repaint (`refresh-client`).
   *Close it with:* `GET /v1/sessions/:id/pane-mode` → `{generation, mode, inMode}`.

2. **No context-hook status.** Tether checks each tool's `contextHook` at launch,
   but the result is not exposed. Aico's titlebar badge (green check or red
   warning for the agent's Agent Hub context) is gone for now.
   *Close it with:* a `contextHook: {state: "available"|"missing"|"unknown", detail}`
   field on the session descriptor (or on `GET /v1/sessions/:id/diagnostics`),
   plus a `session.updated` event when it changes.

3. **switch-project needs a `projectId`.** `POST /v1/sessions` accepts
   `projectRoot` alone, but `POST /v1/sessions/:id/switch-project` only takes
   `{generation, projectId}`. Aico's Personal Workspace is a root, not a project,
   so "switch this session to Personal Workspace" is refused with a notice.
   *Close it with:* accept `{generation, projectRoot}` (absolute directory) as
   create does.

4. **`tether --json version` is not pure JSON and needs the daemon.** It prints a
   `tether 0.0.1` banner line before the JSON object, and with no daemon it
   prints "not reachable" and no JSON at all. `scripts/aico-install.sh` parses
   from the first `{` and treats a missing daemon as "install and start Tether".
   *Close it with:* JSON-only stdout under `--json`, and a `daemon: null` (or an
   error object) when the socket is absent, so the CLI version is still reported.

5. **No current project.** Old Aico read `st projects list`, whose rows carry a
   `current` flag, and the picker could mark it. Tether's `/v1/projects` has no such field, so `current`
   is always `false`. *Close it with:* nothing in Tether unless a client needs
   it; recorded so the empty flag is not mistaken for a bug.

6. **Legacy sockets are default-instance only, and `st aico` ignores
   `TETHER_SOCKET`/`TETHER_INSTANCE`.** `scripts/aico-root-watch.py` (the
   `st aico` client) talks to `/run/user/<uid>/aico/{control,gui-control}.sock`,
   which only `tether@default` serves. SummitFlow now passes `TETHER_SOCKET` and
   `TETHER_INSTANCE` through to the script, but it does not use them, so
   `st aico` cannot be pointed at `tether@dev` for testing.
   *Close it with:* either serve the legacy routes on every instance at
   `$XDG_RUNTIME_DIR/tether/<instance>/legacy-{control,gui-control}.sock`, or move
   the script to the `/v1` socket (the roots and widgets routes exist there).

7. **The root-watch script exists twice.** `scripts/aico-root-watch.py` is in both
   repos. Tether's copy equals Aico's copy before commit `f3b3d45`, so it lacks
   the fix that accepts Tether-shaped A-Term roots (`--surface a-term` with 8-hex
   host identities and `aico://widget/...` locators), and Tether has no copy of
   `test_aico_root.py`, `test_aico_create.py` or `test_aico_widget.py`.
   SummitFlow's tool registry runs Aico's copy. *Close it with:* one owner. If
   Tether takes it, copy the fix and those three test files in the same change,
   then point the tool registry at Tether's path and delete Aico's copy.

8. **Legacy A-Term sessions are attach-only, with no events and no resize
   claim.** `GET /v1/legacy-sessions` lists A-Term's pre-Tether
   `summitflow-<uuid>` sessions with no generation. Aico shows them in its
   session list and opens them attach-only (no view row, no End, no rename, no
   resize claim). The list is read on demand; no event announces new or ended
   legacy sessions. This is by design until they end, and is recorded so nobody
   expects more.

9. **Events carry IDs only.** `session.updated` has `{id, generation}`; Aico
   fetches the descriptor for every update. Fine at today's scale (a few dozen
   sessions); a `descriptor` field in the event would remove the round trip.

## Not applicable to Aico any more

- **Resize claim read `status` without `-A`.** The old Aico read the tmux
  `status` option with `show-options -t <session> -v status`, which prints an
  empty line when the option is only set globally. That code left Aico with the
  lifecycle; Tether's resize claim already uses `show-options -A`
  (`src/lifecycle/tmux.ts`).
- **Admission, context-hook installation, the lifecycle harness, the real-session
  smoke and the Codex admin qualification** all moved to Tether with the code
  they exercise.
