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
- `--on DAY` with `--at` picks the day instead of every day: `mon` (every Monday), `1st-sat` (the
  first Saturday of each month; `1st`, `2nd`, `3rd`, `4th` or `last`), or `day-15` (the 15th of each
  month, 1 to 28 so no month skips it). For example `--at 06:30 --on mon`, `--at 00:30 --on 1st-sat`,
  `--at 08:00 --on 3rd-sun`. The time is read in the same zone as a daily `--at` (the machine's, or
  the pair's with `--hosts either`), so it keeps the wall-clock time across daylight saving: a time
  the clock skips runs an hour later that day, a time it repeats runs at the first. The same
  `at` plus `on` fields work in packages/jobs/data/jobs.json.
- `--command ARGV...` is last on the line. The program is a path (or on the scheduler's PATH);
  `--cwd` defaults to the folder you ran `add` in.
- `--hosts either` runs it on whichever of davion-sidarli and aico is online (the pair is the
  `either` entry in packages/jobs/data/jobs.json). Run `add` on a machine that can run it: it also
  registers the routine on the other one over the fleet link, and refuses (registering nothing) if
  that machine is unreachable. The lease lives on the always-on machine, so a day's slot runs once:
  the home host first, the other after one lease period if the home host did not start it. Routines
  with this setting need their checkout, logins, tools and any state on both machines (not Aico's
  job). Status and Routines show which machine ran it last.
- `--post /api/path` POSTs to Aico web instead of running a command.
- `--scope system` runs it as a system unit (root); the default is a user unit.
- `--kind` is unique across all routines. `--project` is the project id and labels the row.
- A routine that exits 0 is OK; any other exit is Failed with its last output line.
  Exit 75 means "another run holds my lock": not a failure.

Other commands: `aico routines list [--json]`, `remove KIND`, `pause KIND`, `resume KIND`,
`run KIND`, `log KIND`. Registrations live in jobs.db on that machine (they survive deploys);
built-in jobs can be paused but only removed from jobs.json.

## Timers that stay in systemd

Some timers must not depend on the scheduler: the watchdog and heartbeat group
(`host-steward-heartbeat`, `-rules`, `-fcm-token`, `aico-pve-sender`), the root host-steward jobs and
timers on hosts where `aico-jobs` does not run (Proxmox, the backup container). They stay systemd
timers and show in Routines as read-only rows (source "systemd"), one per host, named
`UNIT@HOST`. Which timers appear is data: packages/jobs/data/systemd-timers.json (unit, host, scope,
project, what it does, its schedule in plain words, and how to reach each host). To list a timer
there, add an entry; the definition itself stays in its unit file.

- The row reads systemd directly (`systemctl list-timers` and `show`): next run, last trigger, and
  the service's result. A failed service is a failed row; a timer that is not installed or a host
  that does not answer is "Not known", never OK.
- Run now starts the service without waiting (`systemctl start --no-ask-password --no-block`); system
  units use `sudo -n` here and a root hop (or the fleet link) elsewhere, as the file says.
- Pause disables the timer (`disable --now`), Resume enables it (`enable --now`).
- Nothing here posts a Status row or a notice, so none of it reaches the phone (the one phone rule in
  packages/notify/src/phone.ts: only a sender's own interrupt reason does). It appears in Routines
  and its failure count in the collapsed Routines row.
- Show log is not offered for these rows; `aico routines log UNIT@HOST` prints the service's journal.
