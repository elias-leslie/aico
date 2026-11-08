# Scheduled things inventory (2026-11-07, read-only)

Taken 2026-11-07 about 19:10 EST on davion-sidarli. Nothing was started, stopped or edited. The Proxmox host and CT 190/150/160/170 were read over `ssh root@davion-gem` and `pct exec`. VM 180 and CT 191 are stopped and were left off; their rows come from repo files and are marked as such.

The registry (packages/jobs) only does `at HH:MM daily` or `every_min` (1 to 1440), a command argv (with `cwd`) or an HTTP POST, on a machine where `aico-jobs` runs (today the workstation and CT 190 `aico`). No weekly, monthly or weekday schedules, no sandboxing, no run-as-another-user, no boot trigger. "Move into registry?" uses that yardstick. `leases.ts` stores `next_run` in jobs.db, so an overdue daily job looks like it runs after a restart (read from code, not tested), which is what systemd `Persistent=true` gave these timers.

## Done 2026-11-07 (follow-up)

- The five "move first" timers are routines now: `ominull-fleet-coverage`, `bugout-lab-guest-reaper`, `agent-browser-idle-reaper` and `blackbox-archive` registered by their projects on the workstation, `aico-state-snapshot` a jobs.json job homed on `aico`. Their user timers are gone; each project's installer or README no longer brings them back. The legacy agent-skills copy of the idle reaper is deleted.
- Summary 7 (snapshot oddity): `scripts/snapshot-state.mjs` and its timer belong to CT 190 only. The Drive backup of the gem container starts `aico-state-snapshot.service` on demand (`remoteSqlite` in packages/ops/data/backups.json) and reads the copies. The workstation's `~/.local/state/aico-snapshot` is written by `aico backups` itself (`stageSqlite`), which is why it stays fresh with no timer; the workstation never had the timer because `st service rebuild` does not run install.sh. install.sh no longer starts the timer; the hourly run is the job.
- Summary 6 (trim): `pct-fstrim` is removed from davion-gem; `aico-pve-trim` stays (Aico's repo installs it, it keeps a state file and a Status row that goes stale, takes a lock, runs at idle priority).

## Summary

1. Counts of project-owned scheduled things (distro housekeeping excluded): workstation 5 live user timers + 5 disabled user timers + 11 host-steward system timers + 21 Aico jobs.json jobs (already in the registry); CT 190 2 (1 timer + 1 heartbeat) + the 5 jobs.json jobs homed there; Proxmox host 4 timers (+ 1 disabled) and 0 vzdump jobs; CT 160 1; VM 180 2 systemd timers + 49 app-internal cron jobs; CT 191 1 timer + 7 app-internal jobs. No crontabs or `at` jobs anywhere with real content.
2. Move first (plain command on a host the scheduler runs on, daily or interval): `ominull-fleet-coverage` (every 15 min), `bugout-lab-guest-reaper` (hourly), `agent-browser-idle-reaper` (every 5 min), `blackbox-archive` (daily 03:15), CT 190 `aico-state-snapshot` (hourly).
3. Weekly or monthly timers (`ominull-proveout`, scrubs, NVMe tests, `restic-append-maintain`, trims, `acct`) cannot move until the registry gets weekday/monthly support; they are marked no-keep for now.
4. Keep as systemd on purpose: the watchdog/heartbeat group (`host-steward-heartbeat`, `-rules`, `-fcm-token`, `aico-pve-sender`) must not depend on the scheduler they report on; the other 7 host-steward timers are root-run and installed by their own installer (they need `scope: system` first).
5. Surprise: the Proxmox host has NO vzdump/backup jobs (`/etc/pve/vzdump.cron` empty, `pvesh get /cluster/backup` returns `[]`). Guest recovery rests on Aico's backups jobs, restic-append and the BlackBox snapshots.
6. Surprise: duplicate weekly container trim on the Proxmox host: `aico-pve-trim.timer` (`pve-sender trim`, never run yet) and `pct-fstrim.timer` (ran 2026-11-04). Both run `pct fstrim` on every running CT. One should go.
7. Surprise: `scripts/install.sh` lists `aico-state-snapshot.timer` as a started unit and `scripts/systemd/` holds it, but the workstation has no such timer (only CT 190 does), although `~/.local/state/aico-snapshot` is still refreshed (18:53 today, writer not identified).
8. Surprise: `agent-browser-idle-reaper.timer` is defined in two repos with different schedules (`browser-automation`: every 5 min, installed; `agent-skills/skills/zzagent-browser`: every 2 min, legacy copy). Five `google-photos-*` user timers are disabled July leftovers (scripts dated Jul 16).
9. Surprise: every `/etc/systemd/system/host-steward-*` and `aico-split-dns.service` file has mtime 19:09 today, i.e. another agent's installer ran minutes before this inventory. Treat host-steward unit definitions as in flux.
10. Not read: nightshift and SummitFlow service internals (they live under `~/.summitflow`, outside the allowed search roots), aico-web/tether in-process loops, ominull-hub (CT 150 has no timers), VM 180 and CT 191 runtime state.

Cron expressions below are copied from the repos; Portfolio's are UTC.

---

## 1. Workstation davion-sidarli (America/New_York, EST now)

### 1a. Systemd user timers (`~/.config/systemd/user`, user kasadis, lingering)

| Name | Defined | Scope | Schedule (as defined / plain) | Runs | Project | Last / next | Move into registry? |
|---|---|---|---|---|---|---|---|
| agent-browser-idle-reaper | `/home/kasadis/.config/systemd/user/agent-browser-idle-reaper.{timer,service}` (source `projects/browser-automation/scripts/systemd/`) | user | `OnBootSec=2min`, `OnCalendar=*:3/5`, Accuracy 10s / every 5 min (minutes 3,8,13...) | Two commands, the first with `-` (failure ignored): `<release>/.venv/bin/python -m browser_automation --local-ai reap-isolated`, then `... session reap`; cwd = browser-automation release dir `33b247f4...`; 6 min timeout | browser-automation | last 19:08, next 19:13; Result success | yes: `every_min 5`, two argv (or one wrapper). The unit pins a release-hash path that changes on rebuild; register with the stable service path |
| blackbox-archive | `.../blackbox-archive.{timer,service}` (source `projects/blackbox/deploy/backup/systemd/`) | user | `OnCalendar=*-*-* 03:15:00`, RandomizedDelay 900s, Persistent / daily 03:15 plus up to 15 min | `%h/.local/share/blackbox/archive-pull.sh`; `ConditionPathIsDirectory=/media/kasadis/Backups`; Nice 10, idle IO | blackbox | last 03:21 today (ended "done: 1116 blobs"), next Sun 03:15 | yes: `at 03:15`; the script must exit quietly when `/media/kasadis/Backups` is missing (the systemd Condition goes away). Loses Nice/idle IO |
| bugout-lab-guest-reaper | `.../bugout-lab-guest-reaper.{timer,service}` (source `projects/bugout/operators/lab_guests/systemd/`) | user | `OnCalendar=*-*-* *:20:00`, Persistent / hourly at :20 | `/usr/bin/python3 -m operators.lab_guests`, cwd `/srv/workspaces/projects/bugout`, 15 min timeout, PATH set in unit | bugout | last 18:20, next 19:20 | yes: `every_min 60`, `cwd` set; the :20 anchor is lost |
| ominull-fleet-coverage | `.../ominull-fleet-coverage.{timer,service}` | user | `OnBootSec=3min`, `OnUnitActiveSec=15min` / every 15 min | `/usr/bin/python3 -I /home/kasadis/.local/lib/ominull/fleet_coverage.py` (posts an Aico Status row) | ominull | last 18:59, next 19:14 | yes: `every_min 15` |
| ominull-proveout | `.../ominull-proveout.{timer,service}` + `ominull-proveout.service.d/*.conf` | user | `OnCalendar=Mon *-*-* 06:30`, Persistent / weekly, Mondays 06:30 | `/usr/bin/python3 -I %h/.local/lib/ominull-proveout/proveout-weekly.py --hub http://192.168.86.58:9999 --key-file %h/.config/credstore/ominull/hub-admin.key --rules ... --out-dir /srv/workspaces/vault/wiki/projects/ominull/proveout` (the drop-in deliberately runs a reviewed copy in `$HOME`; hub address hard-coded) | ominull | last Mon 2026-11-02 08:55, next Mon 2026-11-09 06:30 | no-keep: weekly (registry has only daily/interval); revisit with weekday support. The reviewed-copy arrangement would carry over unchanged |
| google-photos-autobackup-progress | `.../google-photos-autobackup-progress.{timer,service}` | user | disabled; `OnBootSec=5min`, `OnUnitActiveSec=30min` | `~/.local/bin/snapshot-google-photos-progress` | none (personal Google Photos migration, July) | not scheduled | no-keep: disabled leftover; retire candidate (owner's call) |
| google-photos-batch-controller | same dir | user | disabled; `OnBootSec=2min`, `OnUnitActiveSec=2min` | `~/.local/bin/advance-google-photos-batch-lanes` | none | not scheduled | no-keep: disabled leftover |
| google-photos-lane1-progress | same dir | user | disabled; `*:01/10` | `snapshot-google-photos-lane2-progress` with `LANE_NUMBER=1` | none | not scheduled | no-keep: disabled leftover |
| google-photos-lane2-progress | same dir | user | disabled; `*:06/10` | `snapshot-google-photos-lane2-progress` | none | not scheduled | no-keep: disabled leftover |
| google-photos-union-progress | same dir | user | disabled; `*:08/10` | `snapshot-google-photos-union-progress` | none | not scheduled | no-keep: disabled leftover |

Distro, leave (user): `snap.firmware-updater.firmware-notifier`, `launchpadlib-cache-clean`, `ubuntu-insights-collect`, `ubuntu-insights-upload` (enabled); `podman-auto-update`, `systemd-tmpfiles-clean` (disabled).

### 1b. Systemd system timers (`/etc/systemd/system`, root)

All 11 are host-steward (project aico, `native/host-steward`, sources in `native/host-steward/systemd/`, binary `/usr/local/lib/host-steward/host-steward`). Their `.service` files are `Type=oneshot`. `[acting]` in `checks.toml` currently has every controller switched on (memctl, housekeeping, space_guard, scrub, nvme_tests), so none is a dry run now. The installer (`install-root.sh`) disables the scrub and NVMe timers when their switch goes off, so the installer owns these units.

| Name | Defined | Scope | Schedule (as defined / plain) | Runs | Last / next | Move into registry? |
|---|---|---|---|---|---|---|
| host-steward-rules | `/etc/systemd/system/host-steward-rules.{timer,service}` | system | `OnBootSec=2min`, `OnUnitActiveSec=1min` / every minute | `host-steward rules` | last 19:08:59, next 19:09:59 | no-keep: watchdog-type, must run even if aico-jobs is down |
| host-steward-heartbeat | `.../host-steward-heartbeat.{timer,service}` | system | `OnBootSec=30s`, `OnUnitActiveSec=5min` / every 5 min | `/usr/bin/python3 -m host_steward.heartbeat` (heartbeat to Proxmox) | last 19:09:18, next 19:14:18 | no-keep: the dead-man signal cannot depend on the scheduler it vouches for |
| host-steward-fcm-token | `.../host-steward-fcm-token.{timer,service}` | system | `OnBootSec=30s`, `OnUnitActiveSec=20min` / every 20 min | `/usr/bin/python3 -m host_steward.fcm_token` (phone sender access token) | last 18:57, next 19:17 | no-keep: part of the alert path (owner alerts go via FCM), keep independent |
| host-steward-check | `.../host-steward-check.{timer,service}` | system | `OnCalendar=*:0/15`, RandomizedDelay 30s, Persistent / every 15 min | `host-steward check` (runs due checks from `checks.toml`, Nice 10) | last 19:00, next 19:15 | no-keep: root-run; needs scope system |
| host-steward-space-guard | `.../host-steward-space-guard.{timer,service}` | system | `OnBootSec=2min`, `OnUnitInactiveSec=15min`, RandomizedDelay 1min / about every 15 min after each run | `host-steward space-guard` (Nice 19) | last 19:00, next 19:15 | no-keep: root-run disk-pressure guard, should not wait on the scheduler |
| host-steward-collect-usage | `.../host-steward-collect-usage.{timer,service}` | system | `OnCalendar=*-*-* 04:40`, RandomizedDelay 10min, Persistent / daily 04:40 | `host-steward collect-usage` (Nice 19, idle IO) | last 04:43 today, next Sun 04:41 | no-keep for now: root-run; first candidate for `scope: system` |
| host-steward-housekeeping | `.../host-steward-housekeeping.{timer,service}` | system | `OnCalendar=*-*-* 05:15`, RandomizedDelay 10min, Persistent / daily 05:15 | `host-steward housekeeping` (journal, caches, SummitFlow retention; Nice 15) | last 05:21 today, next Sun 05:21 | no-keep for now: root-run; `scope: system` |
| host-steward-nvme-short-test | `.../host-steward-nvme-short-test.{timer,service}` | system | `OnCalendar=Sat *-*-* 03:00`, RandomizedDelay 10min, Persistent / every Saturday 03:00 | `host-steward nvme-test short` | last Sat 03:01, next Sat 2026-11-14 | no-keep: weekly |
| host-steward-nvme-long-test | `.../host-steward-nvme-long-test.{timer,service}` | system | `OnCalendar=Sat *-*-01..07 00:30`, Persistent / first Saturday of the month 00:30 | `host-steward nvme-test long` | last Sat 00:32, next 2026-12-05 | no-keep: monthly weekday rule |
| host-steward-scrub-root | `.../host-steward-scrub-root.{timer,service}` | system | `OnCalendar=Sun *-*-01..07 08:00`, RandomizedDelay 15min, Persistent / first Sunday of the month | `host-steward scrub --target root` (Btrfs, Nice 15) | last Tue 2026-11-03 21:50 (catch-up), next 2026-12-06 | no-keep: monthly weekday rule |
| host-steward-scrub-native | `.../host-steward-scrub-native.{timer,service}` | system | `OnCalendar=Sun *-*-15..21 08:00`, RandomizedDelay 15min, Persistent / third Sunday of the month | `host-steward scrub --target native` (`/mnt/summitflow-native`) | last Tue 2026-11-03 21:50 (catch-up), next Sun 2026-11-15 | no-keep: monthly weekday rule |

Host-steward also keeps its own sub-schedule in `checks.toml`: 28 check entries with `every_min` (15 for most; 60 for `gates`; 360 for `router-drift` and `disk-tests`; 1440, 10080, 43200 and 44640 for some usage and disk-test items). The 15-minute `host-steward-check` tick dispatches them. app-internal, not separate timers.

Non-timer host-steward services (not scheduled, listed so they are not mistaken for gaps): `host-steward-display-guard`, `-grants`, `-home-off`, `-input-watch`, `-zswap` (system), `host-steward-memctl` (user, running).

Distro, leave (system): `apt-daily`, `apt-daily-upgrade`, `dpkg-db-backup`, `e2scrub_all`, `fstrim`, `fwupd-refresh` (drop-in `fwupd-refresh.timer.d` changes it to daily plus 2h jitter, a summitflow-steward waste cut 2026-10-11), `logrotate`, `man-db`, `mdcheck_start/_continue`, `mdmonitor-oneshot`, `podman-auto-update`, `snapd.snap-repair`, `sysstat-collect/-rotate/-summary`, `systemd-tmpfiles-clean`, `ua-timer`, `update-notifier-download/-motd`, `anacron`, `apport-autoreport`, `acct-monthly-report` (monthly, next 2026-12-01); disabled: `atop-rotate`, `motd-news`, `xfs_scrub_all`; `btrbk.timer` masked (symlink to /dev/null).

### 1c. Cron, at, anacron

| What | Where | Reading |
|---|---|---|
| kasadis crontab | `crontab -l` | none |
| root crontab | `sudo crontab -l` | comments only |
| owner-admin crontab | `sudo crontab -u owner-admin -l` | none |
| `/var/spool/cron` | empty | none |
| `/etc/crontab` | stock | run-parts lines only |
| `/etc/cron.d/{anacron,atop,e2scrub_all}` | distro | each is guarded by `test -e /run/systemd/system`, so inert on systemd |
| `/etc/cron.daily` | `apt-compat`, `dpkg`, `logrotate`, `man-db`, `apport`, `0anacron`, plus vendor `brave-browser`, `google-chrome`, `google-earth-pro` | distro/vendor, leave |
| `/etc/cron.weekly`, `.monthly`, `.yearly` | `man-db`, `acct`, `0anacron` | distro, leave |
| `at` jobs | `atq` is not installed, `/var/spool/at*` absent | none |

### 1d. Aico jobs.json (already in the registry; completeness only)

`packages/jobs/data/jobs.json`, scheduler `aico-jobs.service` (user, active). 21 jobs, all project aico: 15 homed on the workstation, 5 on `aico`, and `note-reminders` shared.

| Kind | Home | Schedule | Run |
|---|---|---|---|
| backups-drill | davion-sidarli | at 06:00 | `aico backups drill --scheduled` |
| check-nightly | davion-sidarli | at 01:30 | `aico nightly --source aico` |
| github-publish | davion-sidarli | at 03:05 | `aico publish --all` |
| morning-digest | davion-sidarli | at 07:30 | POST `/api/digest/push` |
| notes-export | davion-sidarli | at 03:30 | POST `/api/export/notes` |
| note-reminders | lease host aico, workers both | every 1 min | POST `/api/notes/reminders/run` |
| context-unused | davion-sidarli | at 04:10 | POST `/api/context/check` |
| usage-collect | davion-sidarli | every 5 min | `aico usage collect` |
| backups-native | davion-sidarli | every 240 min | `aico backups run native --scheduled` |
| backups-drive | davion-sidarli | at 04:00 | `aico backups run drive --scheduled` |
| backups-append | davion-sidarli | every 60 min | `aico backups run append --scheduled` |
| backups-snapshots | davion-sidarli | every 30 min | `aico backups run snapshots --scheduled` |
| backups-guard | davion-sidarli | every 5 min | `aico backups run guard --scheduled` |
| backups-verify | davion-sidarli | at 05:00 | `aico backups run verify --scheduled` |
| wip-mirror-davion-sidarli | davion-sidarli | every 10 min | `aico wip run` |
| peer-release | davion-sidarli | every 15 min | `scripts/peer-release.sh aico-gem aico` |
| notes-export-aico | aico | at 03:30 | POST `/api/export/notes` |
| backups-append-aico | aico | every 60 min | `aico backups run append --scheduled` |
| backups-drive-aico | aico | at 04:30 | `aico backups run drive --scheduled` |
| backups-verify-aico | aico | at 05:30 | `aico backups run verify --scheduled` |
| wip-mirror-aico | aico | every 10 min | `aico wip run` |

jobs.db has no `routines` table yet.

---

## 2. CT 190 `aico` (Aico container, 192.168.86.59, UTC)

Read with `pct exec 190`. aico-jobs runs here too (jobs.json rows homed on `aico` above). No crontab; `/etc/cron.d/e2scrub_all` only.

| Name | Defined | Scope | Schedule | Runs | Project | Last / next | Move into registry? |
|---|---|---|---|---|---|---|---|
| aico-state-snapshot | `/home/kasadis/.config/systemd/user/aico-state-snapshot.{timer,service}` (template `projects/aico/scripts/systemd/`) | user (kasadis, lingering) | `OnCalendar=*-*-* *:10:00`, Persistent / hourly at :10 UTC | `node --disable-warning=ExperimentalWarning <release>/scripts/snapshot-state.mjs` (consistent SQLite copies to `~/.local/state/aico-snapshot` for the host's backup); Nice 10 | aico | last 00:10:38 UTC, next 01:10 UTC; Result success | yes: `every_min 60`, home `aico`. The release path is rendered by install.sh; the registry would use the stable `aico` script. Also decide the workstation question (summary 7) |
| host-steward-heartbeat | `/etc/systemd/system/host-steward-heartbeat.{timer,service}` | system, `User=kasadis`, NoNewPrivileges, ProtectSystem=full, PrivateTmp | `OnBootSec=30s`, `OnUnitActiveSec=5min` | `/usr/bin/python3 -m host_steward.heartbeat` (heartbeat to Proxmox) | aico | last 00:09:23 UTC, next 00:14:23 | no-keep: dead-man signal, sandboxed, independent of aico-jobs |

Distro, leave (CT 190): `apt-daily`, `apt-daily-upgrade`, `dpkg-db-backup`, `e2scrub_all`, `logrotate`, `man-db`, `systemd-tmpfiles-clean`, `fstrim` (never fires in a container; the host trims instead).

## 3. Proxmox host davion-gem (192.168.86.39, pve-manager 9.2.24, America/New_York)

Read with `ssh root@davion-gem`. No `/etc/pve/jobs.cfg`, no vzdump jobs: `/etc/pve/vzdump.cron` has only the header, `pvesh get /cluster/backup` returns `[]`. Root crontab empty, no `at`. Only distro cron entries (`e2scrub_all`, `zfsutils-linux`, run-parts, vzdump symlink). The Aico scheduler does not run here.

| Name | Defined | Scope | Schedule | Runs | Project | Last / next | Move into registry? |
|---|---|---|---|---|---|---|---|
| aico-pve-sender | `/etc/systemd/system/aico-pve-sender.{timer,service}` (source `projects/aico/native/pve-sender/systemd/`) | system | `OnBootSec=1min`, `OnUnitActiveSec=5min`, Accuracy 15s / every 5 min | `/usr/local/sbin/pve-sender tick` (phone sender and Proxmox watchdog; deadman alerts when the workstation is down); UMask 0077, NoNewPrivileges, ProtectSystem=full, PrivateTmp, 6 min timeout | aico | last 19:09:17, next 19:14:17; success | no-keep: the alert path for when the workstation is down, sandboxed, and no Aico scheduler on this host |
| aico-pve-trim | `/etc/systemd/system/aico-pve-trim.{timer,service}` | system | `OnCalendar=weekly`, Persistent / Mondays 00:00 | `/usr/local/sbin/pve-sender trim` (runs `pct fstrim` for running CTs); Nice 19, idle IO | aico | never run yet, next Mon 2026-11-09 00:00 | no-keep: weekly, host without scheduler. Duplicate of `pct-fstrim` (summary 6) |
| pct-fstrim | `/etc/systemd/system/pct-fstrim.{timer,service}` | system | `OnCalendar=weekly`, RandomizedDelay 1h, Persistent / weekly | `/bin/sh -c 'for c in $(pct list | awk "$2==\"running\"{print $1}"); do pct fstrim $c \|\| true; done'` | unowned (no repo source found) | list-timers shows no timer-driven run yet (last "-"); the journal has one run on 2026-11-04 11:15, probably started by hand; next Mon 2026-11-09 00:23 | no-keep: weekly, host without scheduler. Unowned and duplicate: delete one of the two |
| blackbox-snapshot | `/etc/systemd/system/blackbox-snapshot.{timer,service}` (source `projects/blackbox/deploy/backup/systemd/`) | system | `OnCalendar=hourly`, RandomizedDelay 120s, Persistent / hourly | `/usr/local/sbin/blackbox-snapshot` (vault SQLite copy, filesystem snapshot when supported, prune, heartbeat); `ConditionPathIsDirectory=/vault` | blackbox | last 19:01:41, next 20:01:43; success | no-keep: needs root on the PVE host where the vault lives; no scheduler there. Only movable if a scheduler (or an ssh-driven routine) runs on the host |
| cloudflared-update | `/etc/systemd/system/cloudflared-update.timer` | system | disabled; `OnCalendar=daily` | cloudflared update | none | not scheduled | no-keep: disabled leftover |
| pve-daily-update | `/usr/lib/systemd/system/pve-daily-update.timer` | system | `*-*-* 1:00` +5h jitter | `pveupdate` then `unattended-upgrade` | distro (Proxmox) | last 02:40, next Sun 03:48 | no-keep: distro, leave |

Distro, leave (PVE): `apt-daily`, `apt-daily-upgrade`, `dpkg-db-backup`, `e2scrub_all`, `fstrim` (host), `logrotate`, `man-db`, `xfs_scrub_all`, `systemd-tmpfiles-clean`; disabled: `apt-listchanges`, `chrony-dnssrv@`, `proxmox-firewall`, `zfs-*`. `/usr/local/lib/host-steward` is installed on the host but no host-steward timer exists there.

Other containers (read over `pct exec`, UTC):

| Name | Defined | Scope | Schedule | Runs | Project | Last / next | Move into registry? |
|---|---|---|---|---|---|---|---|
| restic-append-maintain (CT 160 restic-append) | `/etc/systemd/system/restic-append-maintain.{timer,service}` (source `projects/aico/native/backup-hosts/restic-append/`) | system, `User=restic` | `OnCalendar=Sun *-*-* 05:15`, RandomizedDelay 30m, Persistent / weekly Sunday 05:15 UTC | `/usr/bin/python3 -I /usr/local/sbin/restic-append-maintain.py` (retention, prune, data check); `ConditionPathExists=/srv/restic/repo/config`; 12 h timeout; Nice 15 | aico | last Sun 2026-11-01 05:19 UTC, next Sun 2026-11-08 05:44 UTC | no-keep: weekly, runs as the restic user on the append-only host that must not hold Aico credentials |
| CT 150 ominull-hub | none | | | | ominull | | nothing scheduled by systemd or cron (only `e2scrub_all`); in-process loops unread |
| CT 170 opencanary | none | | | | | | nothing scheduled by systemd or cron |

---

## 4. VM 180 `apps` (portfolio-ai) and CT 191 `jobinator` (both stopped, left off)

`qm list` shows VM 180 `apps` stopped; `pct list` shows CT 191 `jobinator` stopped (so jobinator-4000 lives in CT 191, not VM 180). Rows come from repo files; "unread: VM off" for runtime state. Neither guest runs the Aico scheduler. Both apps are on demand and catch up missed work by themselves when started (the owner's rule for on-demand apps), which is the reason to leave their schedulers alone.

### 4a. Systemd units from the repos

| Name | Defined | Scope | Schedule | Runs | Project | Last / next | Move into registry? |
|---|---|---|---|---|---|---|---|
| app-db-snapshots | `projects/portfolio-ai/scripts/vm-stack/app-db-snapshots.{timer,service}`; installed to VM 180 `/etc/systemd/system/` by `vm-stack/install.sh` | system (VM 180) | `OnCalendar=*-*-* 00/4:10:00 UTC`, Persistent / every 4 h at :10 UTC | `/usr/bin/python3 /opt/app-stack/capture-current.py` as kasadis, waits for PostgreSQL up to 5 min, 30 min timeout; companion `app-db-shutdown-dump.service` dumps at VM shutdown | portfolio-ai | unread: VM off | no-keep: lives on an on-demand VM; the shutdown-dump pairing is systemd ordering |
| portfolio-backup | `projects/portfolio-ai/scripts/systemd/portfolio-backup.{timer,service}`; user unit on VM 180 per `docs/production-release.md` | user (VM 180) | `OnCalendar=Sun *-*-* 04:45:00 America/New_York`, Persistent / weekly Sunday 04:45 ET | `scripts/portfolio-backup.sh --mode native --backup-dir <dir> --allow-live --no-prune` after PostgreSQL is ready; 2 h timeout | portfolio-ai | unread: VM off | no-keep: weekly, on the on-demand VM (also run by the release script before deploys) |
| jobinator-4000-snapshot | `projects/jobinator-4000/scripts/systemd/jobinator-4000-snapshot.{timer,service}` (CT 191) | system (CT 191) | `OnCalendar=*:17`, `Persistent=false` / hourly at :17 | `/opt/jobinator/backend/.venv/bin/python /opt/jobinator/backend/scripts/sqlite_snapshot.py /var/lib/jobinator` as user jobinator | jobinator-4000 | unread: CT off | no-keep: lives on an on-demand container; not read from the live CT |

Open question: `vm-stack/app-db-snapshots.service` still loads `/etc/app-config/jobinator.env` (`JOBINATOR_DB_URL`, a PostgreSQL URL), while jobinator-4000 is SQLite in CT 191. Whether an older Postgres Jobinator still runs on VM 180 is unread (VM off).

### 4b. Portfolio AI in-process scheduler (app-internal)

Worker `python -m app.worker` (`portfolio-worker.service`), `backend/app/scheduler.py`: croniter crons, all UTC, 15 s tick, catches up one run per job after a stop, state in the `scheduled_jobs` table. Crons are declared in `backend/app/workflows/data_refresh_schedules.py`; docs in `docs/scheduling.md`. 49 cron jobs (+ 8 on-demand-only). Verdict for every row: app-internal (the app's own catch-up scheduler is built for a VM that is usually off; a registry routine would need the VM up and an HTTP/CLI entry point per job).

Data refresh
| Job | Cron (UTC) | Plain |
|---|---|---|
| portfolio-refresh-ohlcv | `0 2 * * *` | daily 02:00 |
| portfolio-refresh-watchlist-ohlcv | `15 2 * * *` | daily 02:15 |
| portfolio-backfill-indicators | `30 2 * * *` | daily 02:30 |
| portfolio-refresh-watchlist-intraday | `0 13-21 * * 1-5` | hourly 13:00-21:00 on weekdays |
| portfolio-capture-macro-tape | `*/10 13-21 * * 1-5` | every 10 min 13:00-21:50 on weekdays |
| portfolio-fg-inputs | `45 2`, `15 15`, `15 17`, `47 21` daily | 4x daily |
| portfolio-fg-calc | `2 3`, `30 15`, `30 17`, `0 22` daily | 4x daily |
| portfolio-maintain-historical | `15 4 * * *` | daily 04:15 |
| portfolio-options-activity | `15 21 * * *` | daily 21:15 |
| portfolio-putcall-ratio | `30 14 * * *`, `39 21 * * *` | 2x daily |
| portfolio-ingest-fundamentals | `10 6 * * 0` | Sundays 06:10 |
| portfolio-ingest-macro | `30 6 * * *` | daily 06:30 |
| portfolio-market-macro-calendar-ingestion | `5 11 * * *` | daily 11:05 |
| portfolio-refresh-watchlist-scores | `15 21 * * *` | daily 21:15 |
| portfolio-refresh-news-sentiment | `25 */3 * * *` | every 3 h at :25 |
| portfolio-profile-news | `0 */12 * * *` | every 12 h |

Reference, strategy, accounts, household
| Job | Cron (UTC) | Plain |
|---|---|---|
| portfolio-yfinance-ref | `2 4 * * *` | daily 04:02 |
| portfolio-valuation-metrics | `30 4 * * *` | daily 04:30 |
| portfolio-earnings-surprises | `10 5 * * 0` | Sundays 05:10 |
| portfolio-financial-health | `15 5 * * 0` | Sundays 05:15 |
| portfolio-sec-cik | `5 6 * * 0` | Sundays 06:05 |
| portfolio-aca-landscape | `0 6 15 11 *` | yearly, Nov 15 06:00 |
| portfolio-snapshots | `33 21 * * *` | daily 21:33 |
| portfolio-covariance | `30 5 * * *` | daily 05:30 |
| portfolio-rules-validation | `8 3 * * *` | daily 03:08 |
| portfolio-tlh-scan | `0 13 * * 1-5` | weekdays 13:00 |
| portfolio-drift-snapshot | `0 18 * * *` | daily 18:00 |
| portfolio-sync-accounts | `0 11`, `0 17`, `30 21` on weekdays | 3x on weekdays |
| portfolio-refresh-property-valuations | `0 12 1 * *` | monthly, 1st 12:00 |
| portfolio-research-universe-refresh | `0 11 * * 1` | Mondays 11:00 |
| portfolio-macro-gate | `30 22 * * 1-5` | weekdays 22:30 |
| portfolio-jenny-daily-household-maintenance | `15 13 * * *` | daily 13:15 |
| portfolio-jenny-weekly-price-check | `30 13 * * 6` | Saturdays 13:30 |

Maintenance and cleanup
| Job | Cron (UTC) | Plain |
|---|---|---|
| portfolio-rotate-logs | `45 1 * * *` | daily 01:45 |
| portfolio-cleanup-logs | `0 2 * * *` | daily 02:00 |
| portfolio-cleanup-temp | `15 2 * * *` | daily 02:15 |
| portfolio-vacuum-db | `30 3 * * 0` | Sundays 03:30 |
| portfolio-cleanup-news | `0 4 * * 0` | Sundays 04:00 |
| portfolio-cleanup-agent-runs | `15 4 * * 0` | Sundays 04:15 |
| portfolio-cleanup-backups | `45 4 * * 0` | Sundays 04:45 |
| portfolio-cleanup-snapshots | `0 5 * * 0` | Sundays 05:00 |
| portfolio-cleanup-models | `5 5 * * 0` | Sundays 05:05 |
| portfolio-cleanup-maintenance | `30 5 * * 0` | Sundays 05:30 |
| portfolio-db-size | `36 5 * * *` | daily 05:36 |
| portfolio-cleanup-debug | `15 6 * * *` | daily 06:15 |
| portfolio-check-disk | `0 */6 * * *` | every 6 h |
| portfolio-source-health | `30 */6 * * *` | every 6 h at :30 |
| portfolio-check-freshness | `0 */2 * * *` | every 2 h |
| portfolio-vehicle-due-alerts | `0 14 * * *` | daily 14:00 (posts an owner alert through Aico) |

(Names and crons for this group are from `workflows/maintenance.py` and `data_refresh_schedules.py`.)

### 4c. Jobinator-4000 in-process scheduler (app-internal, CT 191)

`backend/app/scheduler.py`, schedules in `backend/app/workflows/schedules.json` (UTC crons, 60 s tick, runs a missed job once on start, two lanes). 7 jobs, all app-internal. The catch-up design exists because the container is on demand.

| Job | Cron (UTC) | Plain | Lane |
|---|---|---|---|
| nightly_scan_wf (Nightly job scan) | `10 6 * * *` | daily 06:10 | daily |
| webinar_refresh_wf | `45 6 * * *` | daily 06:45 | daily |
| nightly_screen_wf (Job screening) | `30 7 * * *` | daily 07:30 | daily |
| nightly_enrich_wf (Company research) | `30 8 * * *` | daily 08:30 | daily |
| market_trends_wf (Market snapshot) | `0 13 * * *` | daily 13:00 | daily |
| followup_sweep_wf (Follow-up reminders) | `5 * * * *` | hourly at :05 | hourly |
| deferred_ab_sweep_wf (Comparison retries) | `30 * * * *` | hourly at :30 | hourly |

---

## 5. Other projects under /srv/workspaces/projects

Repo `*.timer` files found (depth-bounded search, node_modules/.git/.snapshots excluded) and where each is deployed:

| Repo file | Deployed as |
|---|---|
| `aico/scripts/systemd/aico-state-snapshot.timer` | CT 190 only |
| `aico/native/host-steward/systemd/*.timer` (11) | workstation system units (section 1b); CT 190 heartbeat only |
| `aico/native/pve-sender/systemd/{aico-pve-sender,aico-pve-trim}.timer` | Proxmox host |
| `aico/native/backup-hosts/restic-append/restic-append-maintain.timer` | CT 160 |
| `blackbox/deploy/backup/systemd/blackbox-snapshot.timer` | Proxmox host |
| `blackbox/deploy/backup/systemd/blackbox-archive.timer` | workstation user |
| `bugout/operators/lab_guests/systemd/bugout-lab-guest-reaper.timer` | workstation user |
| `browser-automation/scripts/systemd/agent-browser-idle-reaper.timer` | workstation user (installed copy matches this one) |
| `agent-skills/skills/zzagent-browser/systemd/agent-browser-idle-reaper.timer` | not installed anywhere seen; legacy duplicate, every 2 min |
| `portfolio-ai/scripts/vm-stack/app-db-snapshots.timer`, `portfolio-ai/scripts/systemd/portfolio-backup.timer` | VM 180 |
| `jobinator-4000/scripts/systemd/jobinator-4000-snapshot.timer` | CT 191 |

Not found in repos (defined only on the machine): `ominull-fleet-coverage`, `ominull-proveout` (installed from `~/.local/lib/ominull*`, the proveout script also lives in `projects/ominull/scripts/`), the `google-photos-*` units, and PVE's `pct-fstrim`.

In-app schedulers found by pattern search (node-cron, croniter, apscheduler, `every_min`, `on_crons`, CronTrigger) outside Portfolio and Jobinator: Aico's own `packages/jobs` (the scheduler itself), host-steward `checks.toml` (section 1b), and `neri` (`push_every_min = 5` heartbeat setting in `neri/proxy/neri_proxy/defaults.toml` and `neri/backend/app/st_cli/policy.json`: app-internal, 5 min, not read further). No other project has timers or cron-style schedulers in the searched code. aico-web/tether `setInterval` loops, ominull-hub internals, nightshift and SummitFlow services (under `~/.summitflow`, outside the permitted roots) are unread.

## 6. What a follow-up agent should do first

1. Register as routines on the workstation: `ominull-fleet-coverage`, `bugout-lab-guest-reaper`, `agent-browser-idle-reaper`, `blackbox-archive`; on CT 190: `aico-state-snapshot`. Then disable the matching systemd timers (not needed in this task).
2. Decide the duplicate PVE trim (keep `aico-pve-trim`, delete `pct-fstrim`, or the other way), the missing PVE vzdump jobs, and the five dead `google-photos-*` timers (owner's call to delete).
3. Weekly/monthly schedules: add weekday and day-of-month support to the registry, or leave `ominull-proveout`, scrubs, NVMe tests and restic maintenance as timers.
4. Leave the watchdog group (`host-steward-heartbeat/rules/fcm-token`, `aico-pve-sender`) as systemd.
