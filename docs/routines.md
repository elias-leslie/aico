# Routines

A routine is anything Aico runs on a schedule: its own jobs (packages/jobs/data/jobs.json) and the
ones other projects register. The web app lists them all in Routines (System): schedule, next run,
last result, Run now, Pause or Resume, and the last output. Each routine takes the scheduler's
lease, runs as its own systemd unit and writes one Status row (`jobs/KIND`), so it has the same
Status, tray and digest behavior as a built-in job. A failed routine is a tray and digest item;
it reaches the phone only if its own command sends `aico notify ... --interrupt REASON`.

## Register one

Run on the machine that should run it (the default host is the machine you are on):

    aico routines add --project school-check --kind school-check \
      --what "Nightly school check" --at 19:00 \
      --cwd /srv/workspaces/projects/school-check --command ./scripts/check.sh

- `--at HH:MM` runs daily at that local time; `--every MINUTES` repeats after each run finishes.
- `--command ARGV...` is last on the line. The program is a path (or on the scheduler's PATH);
  `--cwd` defaults to the folder you ran `add` in.
- `--post /api/path` POSTs to Aico web instead of running a command.
- `--scope system` runs it as a system unit (root); the default is a user unit.
- `--kind` is unique across all routines. `--project` is the project id and labels the row.
- A routine that exits 0 is OK; any other exit is Failed with its last output line.
  Exit 75 means "another run holds my lock": not a failure.

Other commands: `aico routines list [--json]`, `remove KIND`, `pause KIND`, `resume KIND`,
`run KIND`, `log KIND`. Registrations live in jobs.db on that machine (they survive deploys);
built-in jobs can be paused but only removed from jobs.json.
