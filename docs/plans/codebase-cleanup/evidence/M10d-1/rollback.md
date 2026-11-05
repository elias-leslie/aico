# Rollback

The SF unit files, project sources, database contents, shared stack and scoped Proxmox credential source remain intact. This procedure is written for an explicit rollback; it has not been executed.

Restore the CLI links before starting SF:

```sh
ln -sfn /srv/workspaces/projects/summitflow/scripts/st /home/kasadis/bin/st
sudo ln -sfn /srv/workspaces/projects/summitflow/scripts/st /usr/local/bin/st
ln -sfn /srv/workspaces/projects/aico/packages/web-server/scripts/aico /home/kasadis/.local/bin/aico
```

The newly created `/home/kasadis/.local/bin/st` should point to the SF launcher too if rolling back the alias. Then restore the old services:

```sh
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
systemctl --user --no-ask-password enable --now summitflow-backend.service summitflow-frontend.service summitflow-hatchet-worker.service
```

The installed Aico command release is the `~/.local/lib/aico/ops` symlink; earlier committed releases remain under `~/.local/lib/aico/releases`. Aico's normal `deploy --rollback --sha COMMIT` restores a chosen committed release. Never restore databases to roll back this CLI change. No Postgres, Redis or Hatchet stop is part of this cutover or its rollback.

Standalone Python environments received SDK 0.2.1. Their former environment paths and installed-version receipt are recorded in the live evidence. If reversing that SDK change, reinstall the previous SDK from the retained SummitFlow source in those exact environments, then verify a standalone metadata command. Neri's environment was not changed. The Proxmox Logins entry can remain unused during rollback; do not delete a credential to undo a launcher change.
