# Cutover: Aico becomes a Tether client

This runbook moves the live desktop from the old Aico (in-process lifecycle plus
`aico-owner.service`) to Tether (`tether@default`) and the Aico built from branch
`tether-client` in `/srv/workspaces/projects/aico-tether`. It is one step with a
rollback. No tmux server or session is stopped at any point: tmux servers run in
their own `aico-tmux-server-*` user units, and both the old owner and Tether
adopt them rather than own their lifetime.

Run it from a terminal **outside** Aico's tmux servers (GNOME Terminal, a TTY or
ssh). Stopping `aico-shell` closes every Aico window; sessions keep running, but
a terminal inside one of them loses its view until the new Aico reopens it.

Do not run `st service rebuild aico` until this branch is merged to `main`. A
rebuild deploys `main`, which still has the old lifecycle and starts
`aico-owner.service` as a default worker.

Shell variables used below:

```sh
AICO_DB="$HOME/.local/state/aico/aico.db"
TETHER_REPO=/srv/workspaces/projects/tether
AICO_NEW=/srv/workspaces/projects/aico-tether
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$HOME/.local/state/aico/cutover-$STAMP"
mkdir -p "$OUT"
TETHER_SOCK="$XDG_RUNTIME_DIR/tether/default/control.sock"
t() { curl -s --unix-socket "$TETHER_SOCK" "http://tether$1"; }
```

## 0. Prepare (nothing live changes)

1. Tether is built and installed but not started, at Tether `7f3606c` or later:

   ```sh
   cd "$TETHER_REPO" && scripts/install.sh       # installs the CLI and units; starts nothing
   systemctl --user is-active tether@default.service   # expect: inactive
   ```

2. The new Aico has its own dependencies. The worktree's `node_modules` and
   `.venv` are symlinks to the main checkout during development; the launcher
   checks the Electron path of the running unit, so give the worktree real ones:

   ```sh
   cd "$AICO_NEW"
   [ -L node_modules ] && rm node_modules    # removes the symlink only
   [ -L .venv ] && rm .venv
   npm ci && npm rebuild electron node-pty
   uv sync --frozen --python 3.13 --extra dev
   npm run build
   ```

3. Record what is live now:

   ```sh
   sqlite3 -readonly "file:$AICO_DB?mode=ro" \
     "SELECT id, x, y, width, height, open, name FROM widgets
      WHERE external_tmux_session IS NULL ORDER BY seq" > "$OUT/widgets-before.txt"
   for id in $(cut -d'|' -f1 "$OUT/widgets-before.txt"); do
     st aico widget status --widget-id "$id"
   done > "$OUT/generations-before.jsonl"
   systemctl --user list-units 'aico-tmux-server-*' --state=active --no-legend \
     > "$OUT/tmux-units-before.txt"
   st aico roots > "$OUT/roots-before.txt" 2>&1 || true
   ```

   Every widget with a running session should appear in
   `generations-before.jsonl` with `status: "running"` and a 64-hex `generation`.

## 1. Stop the old GUI and owner

```sh
systemctl --user stop aico-shell.service aico-owner.service
systemctl --user list-units 'aico-tmux-server-*' --state=active --no-legend \
  | diff - "$OUT/tmux-units-before.txt" && echo "tmux servers unchanged"
```

## 2. Back up aico.db

Use SQLite's own copy (never `cp` a WAL database):

```sh
sqlite3 "$AICO_DB" "VACUUM INTO '$OUT/aico.db.pre-tether'"
sqlite3 -readonly "file:$OUT/aico.db.pre-tether?mode=ro" "PRAGMA integrity_check; SELECT count(*) FROM widgets;"
```

Expect `ok` and the widget count. `~/.local/state` may not be in the host
backups; copy the file somewhere backed up as well if it should outlive the
cutover window.

## 3. Import Aico's catalog into Tether

```sh
tether import-aico            # dry run: review sessions, tmux servers and root requests
tether import-aico --apply    # refuses while tether@default is listening
```

The importer opens `aico.db` read-only and copies `tmux_servers`, `root_requests`
and widget identity columns in one transaction; `external` rows are skipped. If
the dry run lists anything unexpected, stop here and roll back (step 8).

## 4. Start Tether

```sh
cd "$TETHER_REPO" && scripts/install.sh --start default
t /v1/health | jq '{status, lifecycle, catalog, gui}'
```

Wait for `lifecycle: "ready"` (startup reconciliation adopts the imported
`aico-tmux-server-*` units and the historical `/tmp/tmux-<uid>/aico` server). The
legacy `/run/user/<uid>/aico/{control,gui-control}.sock` sockets are served again
from this point, so `st aico` and SummitFlow fleet work before the GUI is back.

Check every live session against step 0:

```sh
tether --json sessions | jq -r '.items[] | "\(.id) \(.status) \(.generation)"' | sort \
  > "$OUT/sessions-after.txt"
jq -r 'select(.status == "running") | "\(.widgetId) running \(.generation)"' \
  "$OUT/generations-before.jsonl" | sort | comm -23 - "$OUT/sessions-after.txt"
```

The last command prints nothing when every session that was running before is
`running` with the same generation.

## 5. Start the new Aico from the worktree

The managed `aico-shell.service` runs from a SummitFlow release directory. A
drop-in points it at the worktree without touching the managed unit file:

```sh
mkdir -p ~/.config/systemd/user/aico-shell.service.d
cat > ~/.config/systemd/user/aico-shell.service.d/50-tether-cutover.conf <<EOF
[Service]
WorkingDirectory=$AICO_NEW
ExecStart=
ExecStart=$AICO_NEW/scripts/aico-run-foreground.sh
EOF
systemctl --user daemon-reload
"$AICO_NEW/scripts/aico-launch.sh"
```

## 6. View migration

Nothing to run. On its first start the new Aico copies each internal widget's
geometry and open state from `widgets` into the new `views` table in one
transaction, records the setting `views-migrated-from-widgets`, and drops
`tmux:` pins (sessions that were attached from outside). `widgets`,
`tmux_servers` and `root_requests` are left untouched. Check it:

```sh
sqlite3 -readonly "file:$AICO_DB?mode=ro" \
  "SELECT value FROM settings WHERE key = 'views-migrated-from-widgets';
   SELECT widget_id, x, y, width, height, open FROM views ORDER BY seq;"
```

The rows should match the geometry in `$OUT/widgets-before.txt`.

## 7. Verify

1. GUI channel: `t /v1/health | jq .gui` shows `{"connected": true}`.
2. Sessions: rerun the comparison from step 4; it still prints nothing.
3. Windows: every widget that was open before reopens at its old position and
   size, attached to the same session (its terminal shows the same scrollback).
4. Roots and the `st aico` facade:

   ```sh
   st aico roots
   st aico widget status --widget-id <an open widget id>
   st aico create cutover-check-$STAMP 'Reply with OK and stop.' \
     --project aico --project-root /srv/workspaces/projects/aico
   st aico root status cutover-check-$STAMP     # running
   st aico root show cutover-check-$STAMP       # its window comes forward
   st aico root end cutover-check-$STAMP        # applied: true; window closes
   ```

5. A new widget from the tray starts, an End from its menu ends it, and a widget
   closed with the window button stays listed under the tray's reopen list.
6. `journalctl --user -u aico-shell.service -n 50` shows
   `[aico:tether] connected at .../tether/default/control.sock` and no
   `startup failed`.

When all of that holds, retire the old owner unit (it is already stopped):

```sh
systemctl --user disable aico-owner.service 2>/dev/null || true
```

Leave its unit file in place until the branch is merged and SummitFlow's Aico
service definition drops the worker (Phase 5); then remove it.

## 8. Rollback

Any time before the old owner unit is removed:

```sh
systemctl --user stop aico-shell.service
# Aico sessions created after step 4 exist only in Tether. End them first, or
# they keep running with no owner the old Aico knows about. Sessions of other
# origins (A-Term, CLI) belong to those clients' own rollback.
tether --json sessions | jq -r '.items[] | select(.origin == "aico") | .id' | sort \
  > "$OUT/sessions-now.txt"
cut -d'|' -f1 "$OUT/widgets-before.txt" | sort | comm -13 - "$OUT/sessions-now.txt" \
  | xargs -r -n1 tether sessions end
systemctl --user disable --now tether@default.service
rm -f ~/.config/systemd/user/aico-shell.service.d/50-tether-cutover.conf
systemctl --user daemon-reload
systemctl --user start aico-owner.service aico-shell.service
```

Stopping Tether stops no tmux server. Tether never writes `aico.db`; the new
Aico only added the `views` table and the migration setting, which the old Aico
ignores, and may have rewritten the `pins` setting without `tmux:` entries. To
put the pins back exactly, with both Aico units stopped:

```sh
sqlite3 "$AICO_DB" "ATTACH '$OUT/aico.db.pre-tether' AS bak;
  UPDATE settings SET value = (SELECT value FROM bak.settings WHERE key = 'pins')
  WHERE key = 'pins';"
```

Then verify with step 0's commands that the old Aico sees the same sessions and
generations.
