# Returning the workstation schedule to SummitFlow

No timer files, repositories, keys or backup data are removed during cutover. `aico backups rollback` prints the old timer enable commands.

Let any active `aico-backup-*` data operation finish. Remove the workstation's `backups-native`, `backups-drive`, `backups-append`, `backups-snapshots`, `backups-guard` and `backups-verify` definitions from `packages/jobs/data/jobs.json`, commit that schedule change, and deploy it with `st service rebuild aico --detach`. Preserve unrelated jobs and CT190's `backups-append-aico` job: CT190 has its own append-only credential and no former SummitFlow equivalent. Do not leave both workstation schedules enabled.

Then re-enable the preserved timers:

```sh
systemctl --no-ask-password --user enable --now summitflow-host-backup.timer
systemctl --no-ask-password --user enable --now btrfs-autosnapshot.timer
sudo -n systemctl --no-ask-password enable --now summitflow-backup-window-guard.timer
systemctl --no-ask-password --user enable --now summitflow-host-verify.timer
```

On an agent shell, set `XDG_RUNTIME_DIR=/run/user/$(id -u)` and `DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus` first if the user bus is not inherited. Declare the actual timer/config change to Nightshift. Verify the four timers are enabled, and inspect their next run. No credential changes or manual prune/forget is part of rollback. Restores still go only into new folders under `/srv/scratch`.
