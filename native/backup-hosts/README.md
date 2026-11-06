# Backup hosts

Root-side pieces of Aico's backups that live outside the Aico service. Names are the ones already installed, so the
paths in `packages/ops/data/backups.json`, the sudoers lines and the forced-command keys stay valid.

| Folder | Installed at | Installer |
|---|---|---|
| `workstation/` | `/usr/local/sbin/summitflow-{backup-window,native-capture,snapshot-delete,steward-receipt}` | `workstation/install.sh` |
| `pve-backup/` | `davion-gem:/usr/local/sbin/summitflow-pve-backup` and `/etc/summitflow-pve-backup/sources.json` | `pve-backup/install.sh` (shows the dispatcher hash and source list, installs on a `--yes DIGEST`) |
| `restic-append/` | `davion-gem` and CT 160 (append-only restic copy) | `restic-append/install.sh` (retention in `policy.json`) |

`pve-backup/sources.json` is what the dispatcher may capture; each digest is the sha256 of the source path in
`backups.json`. Add or change a `proxmox://` source in both, then re-run `pve-backup/install.sh`.
Tests: `native/host-steward/tests/test_pve_backup_dispatcher.py`.
