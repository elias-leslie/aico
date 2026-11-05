# Recover Aico after a machine fails

Backup passwords and the CT 160 SSH keys are in **Hosts → Logins**, marked as backup keys. The owner also keeps them in their offline password manager. If both Aico machines are unavailable, start with that offline copy. Never paste a password into a command, chat or log: save it in a private file (`chmod 600 FILE`). Keep the Drive rclone configuration private too.

Recovery scripts stage files in a **new folder under `/srv/scratch`**. They never activate restored units or overwrite a running machine. Keep the original disks and all backup copies. Install the OS and disks on the replacement first; transferring the verified staging tree and activating services on that replacement is a separate, deliberate step.

## Get the recovery tools

Use a saved Aico checkout or read its source from the T7's `native/workspaces.*` snapshot under `projects/aico`. The plain entry point is `python3 packages/ops/scripts/recovery.py`; no ST, running Aico, database server or model is needed. Retain `packages/ops/{scripts,data}` and `packages/fleet/data/logins-policy.json` together. Requirements: Python 3.12+, Git, rsync, sudo, restic and rclone. The drill additionally needs bubblewrap, Node 22.13+ and built Aico web/Tether bundles with their installed dependencies.

From a working Aico install, the same commands are `aico backups recover …` and `aico backups drill`. `AICO_RECOVERY_CONFIG` selects a different recovery configuration. Plain Python takes `--config FILE` **before** `recover` or `drill`.

## Workstation lost, T7 available

1. Attach the T7 read-only. Copy `packages/ops/data/recovery.json` to a private working configuration. Set its referenced configuration files to absolute paths. Set `scratchRoot` to an existing scratch directory on the replacement.
2. Set `backupState` to the saved `~/.local/state/aico/backups/state.json`. If that receipt is missing or its mount paths changed, create a JSON file with a `points` array containing the actual T7 paths. Each entry has `source` (`/`, `/home`, `/srv/workspaces`), `target` (the matching `native/root.*`, `native/home.*`, `native/workspaces.*` directory) and `dataAt` (the capture date). Keep the original point names and files.
3. Preview, then restore into a new directory:

   ```sh
   python3 packages/ops/scripts/recovery.py --config /PATH/recovery.json recover bootstrap --machine workstation --to /srv/scratch/recovered-workstation --plan
   python3 packages/ops/scripts/recovery.py --config /PATH/recovery.json recover bootstrap --machine workstation --to /srv/scratch/recovered-workstation
   ```

4. The result contains `repo/` (Aico source and Git history), `data/` (databases, photos, Logins), `tether/`, `config/aico/` and `units/{user,system}/`. SQLite WAL files travel with the native databases. Native copying verifies checksums; older files remain in their backup snapshots. Regenerable dependencies and session sockets are excluded.
5. On the fresh replacement, put the reviewed source and state at the configured paths. Review host identity, fleet pins, mount paths and unit paths before reconnecting peers. Install dependencies from the restored lockfile and use the restored repo's `scripts/install.sh` to build/install Aico. Review system units separately; recovery does not start them. Re-run the scratch drill before retiring any original disk.

Other project repos can be restored by adding explicit `path`/`into` items to the workstation machine in the working configuration. Recover only the named project; do not restore the whole projects tree blindly.

## Gem lost, or CT 190 needs rebuilding

With CT 160 still available, `recover bootstrap --machine gem --to /srv/scratch/recovered-gem --plan` previews the CT 190 append snapshot plus the Aico source repo from T7. Run it again without `--plan`. It restores CT 190's consistent databases, its own Logins, photos, user units and Aico configuration. `default-tether.db` is placed at `tether/tether.db`. The CT 190 password/key references are in `recovery.json`; use their offline saved copies if necessary.

If gem itself is gone, CT 160 is gone too. Use the daily Drive copy instead. On the replacement, save `restic-drive.password` and `summitflow-drive.conf` from the offline password manager as private files. The repository location is recorded in `packages/ops/data/backups-import.json` (`restic_remote_repository`). For example:

```sh
python3 packages/ops/scripts/recovery.py recover snapshots --repository rclone:summitflow-drive:SummitFlow-Restic --password-file /PRIVATE/restic-drive.password --rclone-config /PRIVATE/summitflow-drive.conf
python3 packages/ops/scripts/recovery.py recover restore --repository rclone:summitflow-drive:SummitFlow-Restic --password-file /PRIVATE/restic-drive.password --rclone-config /PRIVATE/summitflow-drive.conf --snapshot FULL_ID --path /files-lxc-190.tar --to /srv/scratch/gem-data
```

Choose the snapshot belonging to `pve-ct-190-aico-data` using the Aico Backups snapshot browser, or the plain script's source filter. That tar contains `home/kasadis/.local/state/aico-snapshot` (consistent databases) and `home/kasadis/.local/state/aico` (including Logins and photos). Extract it with `recover extract --archive /srv/scratch/gem-data/files-lxc-190.tar --to /srv/scratch/gem-files`; extraction rejects traversal, devices and links. Restore Aico's repo from the Drive `source:workspaces` snapshot with `--path /srv/workspaces/projects/aico`; restore the relevant units/config from the `source:home` and `source:root` snapshots with explicit paths. The backup browser retains source dates; use the same capture where available.

For the whole Proxmox machine, reinstall Proxmox, then restore the saved `pve-host-files` and `pve-cluster-config` copies for inspection in scratch. The Drive guest backups (`vzdump-…`) rebuild guests: restore CT 190 to a **new unused scratch guest ID**, never an existing one, and inspect its mount/network configuration before starting it. The guest copy includes its installed units/source; overlay the newer consistent Aico data only after validation. Physical disk/boot setup, Proxmox network/storage mapping and the final switch to replacement services stay manual.

## Damaged repository

Run `recover check --repository /LOCAL/REPO --password-file /PRIVATE/password` first. All source inspection/restoration uses `--no-lock --no-cache`: it never unlocks, prunes, forgets, repairs or deletes anything in the original repository. Drive authentication is copied to private scratch before use so token refresh cannot rewrite the owner's auth file.

For a local damaged repository, run `recover repair --repository /LOCAL/REPO --password-file /PRIVATE/password --to /srv/scratch/repository-copy`. It records the original diagnosis, makes a separate copy, rebuilds **that copy's index**, and checks it. Missing backup packs cannot be recreated by index repair: retain every copy and use another backup if the check still fails. Download a remote repository to a new scratch directory before this step. Restore from the verified copy with `recover restore … --snapshot FULL_ID --path /ABSOLUTE/PATH --to /srv/scratch/files`. No operation promotes a repaired repository over the original.

## Repeat the drill

`aico backups drill --plan` shows its scope. `aico backups drill` restores both machines and a project repository, starts real Aico web/Tether in a disposable runtime without network access or live sockets, checks database integrity and served sessions/notes/Logins counts, verifies Git, then removes only its own scratch targets. Counts are compared with the selected backup, whose capture date may precede live changes.

Aico's `backups-drill` job checks daily at 06:00 and runs the drill once per calendar month. Manual runs always run immediately. A failed attempt stays failed until a manual run or the next monthly attempt succeeds. The dated Status row feeds the existing tray/app alerts; `~/.local/state/aico/backups/drill.json` records counts, source snapshots, elapsed seconds, manual steps and cleanup. No backup retention changes are part of recovery.
