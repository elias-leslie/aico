# Cutover retrospective, 2026-10-11

On 2026-10-11 Aico and A-Term stopped managing tmux sessions themselves and became clients of `tether@default`. This page summarizes how the move was done and what it showed. The step-by-step procedure is in [migration-plan.md](migration-plan.md).

## Starting point

- Aico's own owner process held two live agent sessions on one tmux server, plus a catalog of 71 tmux server records and 347 root requests in `aico.db`.
- A-Term kept panes, project settings and agent tools in Postgres and had one legacy session on the user's default tmux server.
- Tether had already passed its lifecycle harness and real-session smoke tests on a separate `tether@dev` instance ([LIFECYCLE_HARNESS.md](LIFECYCLE_HARNESS.md)).

The cutover ran on a working desktop with those sessions open. A session that ended or restarted would have counted as a failure.

## Method

1. Record the starting state: repository heads, systemd units and pane scopes, and each live session's generation.
2. Stop the old Aico shell and owner processes. The tmux servers run in their own transient units, so they kept running.
3. Back up `aico.db` with `VACUUM INTO` and check the copy with `integrity_check`.
4. Run `tether import-aico` as a dry run, review the planned inserts, apply it, then run the dry run again to confirm every row reports `same`.
5. Install and start `tether@default`. On startup it adopted the existing tmux server units and recreated Aico's legacy control sockets.
6. Deploy the client builds of Aico and A-Term. A-Term's Postgres data (panes, project settings) moved into its local SQLite file through a separate dry-run-then-apply migration.
7. Exercise both apps against the new daemon with short-lived test sessions, then end them.

## Safeguards

- **Backup first.** The `aico.db` backup was taken before any write and is kept.
- **Dry runs.** Both imports were reviewed as dry runs before they were applied. Running each a second time changed nothing.
- **Fingerprint comparison.** Each live session's generation (a hash of its exact identity) was recorded before the cutover and compared afterwards. Both sessions came back `running` with identical generations. The tmux server unit and every pane scope were checked after each step.
- **Rollback kept.** The importer never writes to `aico.db`, and stopping Tether never stops a tmux server. Rolling back meant stopping `tether@default` and starting the previous Aico release, which was kept for that purpose.

## Outcome

- Both Aico sessions survived with unchanged generations, and their windows reopened where they had been, give or take a few pixels of window manager adjustment.
- A-Term served its legacy session as attach-only and created new sessions on private tmux servers through Tether.
- Create, rename, end, text injection, attach and resize claims worked from either app, and each app saw changes made in the other.
- Restarting `tether@default` with live sessions brought it back to `ready` in about a second, with the same session IDs and generations and no pane affected.

## Issues found

- A-Term's Postgres migration followed `$TMUX` to the wrong tmux server when run from inside a pane and misreported a live session. Running it with `TMUX` unset gave the correct result. The migration was one-shot and is done.
- Right after a create, `tether sessions` could briefly list a session as `uncertain` while `GET /v1/sessions/:id` already said `running`. The list route now verifies the generation itself.
- Listing roots stopped at a fixed limit once tombstones accumulated. Root listing now filters ended requests (`GET /v1/roots?ended=0`).
- Desktop-only actions (the tray and window menus) and the phone gestures in A-Term were not exercised during the cutover. Their underlying API calls were.

After the cutover the old owner service was removed, and the follow-up changes are marked *post-cutover* in [api-v1.md](api-v1.md).
