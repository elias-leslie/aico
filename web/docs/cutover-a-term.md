# A-Term cutover to Tether

This moves a running A-Term from its own tmux sessions and Postgres to Tether.
It is written for the production host (`davion-sidarli`, checkout
`/srv/workspaces/projects/a-term`, services `a-term-backend.service` and
`a-term-frontend.service`). Run every command from the checkout root.

The migration only reads Postgres. Nothing in it writes, alters or drops a
Postgres table, so rollback is a code rollback.

## 0. Preconditions

1. Tether is installed and running as `tether@default.service`, with API
   version 1 or newer:

   ```bash
   systemctl --user is-active tether@default.service
   tether --json version          # apiVersion >= 1
   tether doctor
   curl -s --unix-socket "$XDG_RUNTIME_DIR/tether/default/control.sock" http://tether/v1/health
   ```

   The build must include Tether's A-Term additions (marked *(3a)* in its
   `docs/api-v1.md`; the API version is still 1). This answers
   `"a-term"`, where an older build answers `400 invalid_query` or `"aico"`:

   ```bash
   curl -s --unix-socket "$XDG_RUNTIME_DIR/tether/default/control.sock" \
     'http://tether/v1/roots?origin=a-term' | jq .owner
   ```

2. Aico already runs on Tether (Tether migration Phase 3/4), so both apps share
   one catalog and one tool registry.
3. Note the current A-Term `main` commit for rollback:
   `git rev-parse HEAD > /tmp/a-term-pre-tether.sha`.
4. Pre-Tether A-Term sessions still running on the default tmux server
   (`tmux ls | grep '^summitflow-'`) keep working after the cutover as
   attach-only legacy sessions until they end. Nothing needs to be closed first.

## 1. Bring in the code

```bash
git fetch origin            # if the branch was published; otherwise it is local
git merge --ff-only tether-client
uv sync --extra dev --extra migrate      # psycopg, for the one-shot migration only
```

## 2. Migrate view state (dry run, then apply)

The command reads `DATABASE_URL` from the environment or, as the old service
did, from `.env.local`, `.env` or `~/.env.local`. It never prints it.

```bash
.venv/bin/a-term migrate-from-postgres            # dry run: prints the plan, writes nothing
```

Check the report:

- `source_counts` and `panes` / `project_settings` match Postgres
  (at branch time: 36 panes, 12 project settings, 2 sessions, 4 tools);
- every session has a `result`: `legacy_link` (still running on the default
  tmux server; it stays visible in its pane), `marked_dead` (Postgres said
  alive but its tmux session is gone; reported here only, Postgres untouched),
  `dead`, or `running_without_pane`.

Then write it:

```bash
.venv/bin/a-term migrate-from-postgres --apply
```

This creates `~/.local/state/a-term/a-term.db` (mode 0600) and
`~/.local/state/a-term/tether-tools-import.json`. Running it again inserts
nothing that is already there.

## 3. Import agent tools into Tether

```bash
.venv/bin/a-term import-tools ~/.local/state/a-term/tether-tools-import.json           # dry run
```

This sends the file to Tether's `POST /v1/tools/import` with `dryRun`, so
nothing is written. The report lists `created`, `updated`, `unchanged` and
`differs` (each with the fields that differ). The import is one transaction:
if any entry is invalid, Tether rejects the whole batch with `400` and writes
nothing.

All four A-Term tools already exist in Tether's seed (`claude` is the alias of
`claude-code`), so expect them under `unchanged` or `differs`. The known
difference is `pi`: A-Term ran bare `pi`, Tether seeds `pi --approve` (Tether
reports `argv`, and `displayOrder` if the orders differ). Keep Tether's values
unless you want A-Term's. `--update-existing` overwrites every differing field
of every existing tool in the file, so trim the file to the tools you want to
change first. Only then:

```bash
.venv/bin/a-term import-tools ~/.local/state/a-term/tether-tools-import.json --apply --update-existing
```

`--apply` without `--update-existing` only creates missing tools.

## 4. Rebuild and restart A-Term

```bash
st service rebuild a-term --detach
```

The new backend has no database step. On its first start it also removes the
old global `client-session-changed` tmux hook (the one calling
`/api/internal/session-switch`) from the default tmux server, and the old
`hook-token` file.

The installed backend unit gains `Wants=`/`After=tether@default.service` only
when the unit is re-rendered (`bash scripts/install.sh`). That is ordering
only; A-Term works without it.

## 5. Verify

Backend:

```bash
curl -s http://127.0.0.1:8002/health | jq '{status, tether, tmux}'   # status healthy, tether.status ok
tmux show-hooks -g | grep session-switch || echo "old hook gone"
journalctl --user -u a-term-backend.service -n 50 --no-pager
```

Desktop browser (`http://localhost:3002`):

1. The pane layout from before is back (same panes, names, detached panes).
2. Open a new project pane. `tether sessions` lists its shell and agent
   sessions with origin `a-term`.
3. Open the same session in Aico. Typing in one shows in the other.
4. Focus the A-Term view, then the Aico window, then A-Term again: the active
   view claims the window size each time, and dragging an A-Term pane does not
   steal it back.
5. End the session from Aico: the A-Term pane drops it within a few seconds.
6. Settings > Agent tools lists Tether's tools; renaming one shows in Aico.
7. Projects: with SummitFlow running, "Register project" is unavailable and the
   list matches SummitFlow.
8. A legacy pane (if the migration reported `legacy_link`) still attaches; its
   reset action is hidden; closing it ends that tmux session.

Terminal launchers:

```bash
scripts/tsession projects --format tsv | head
scripts/tcodex <project>                     # outside tmux: attaches (via `tether sessions attach`)
# inside your default tmux: Tether prints the nesting notice, then attaches nested
scripts/tsession open --tool codex --project <project> --attach --print   # Tether's attach target
```

SummitFlow fleet (`a-term` surface, unchanged URL `http://127.0.0.1:8002/v1/roots`):

```bash
curl -s http://127.0.0.1:8002/v1/roots | jq '.owner, [.roots[].origin]'   # "a-term", only "a-term" origins
```

Start a root with `--surface a-term` through `st` as usual and check that it
appears in A-Term after `show`, and that `close` ends it.

Mobile (`https://terminal.summitflow.dev` on the phone):

1. Sign in, open the session switcher, pick a running session.
2. Type with the on-screen keyboard and the arrow/Enter controls.
3. Rotate the phone; the view refits and claims the size when focused.
4. Background the browser for a minute and return; the session reconnects.

Optional emulator run: `bash scripts/mobile-verification.sh workflow`.

## 6. Rollback

The old code still finds its Postgres data untouched.

```bash
git checkout main && git reset --keep "$(cat /tmp/a-term-pre-tether.sha)"
uv sync --extra dev
st service rebuild a-term --detach
```

- Sessions created through A-Term during the cutover keep running in Tether
  and stay visible in Aico; the old A-Term does not show them.
- Pre-Tether sessions on the default tmux server were never touched.
- The old backend sets its global tmux hook again on start.
- `~/.local/state/a-term/a-term.db` is ignored by the old code; delete it
  before a later re-run if the layout should come from Postgres again.

## 7. Later, separately

Once the cutover has run cleanly for a while, retiring the old Postgres
tables (`a_term_*`, `agent_tools`) and removing `DATABASE_URL` from
`.env.local` is a separate, owner-approved step. This cutover does not do it.
