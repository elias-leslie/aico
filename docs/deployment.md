# Aico deployments

From the workstation checkout, commit and check the source, run `st sessions may-disrupt aico`, then `st service rebuild aico --detach`. Tether is a manual worker: deploy it explicitly with `st service rebuild aico --worker tether@default --detach` after the main deploy. Wait for each printed job result and verify health.

## CT 190, the standalone full peer

CT 190 has no Git checkout and has a smaller memory budget. Build and accept the commit on the workstation, then transfer that exact source and its built artifacts into a **new** `/home/kasadis/.local/lib/aico/releases/FULL_COMMIT` directory. Never overlay a prior release or copy runtime state, `.env` files, authentication files, or workstation configuration.

Create the source payload with `git archive FULL_COMMIT`. Overlay only the workstation release's `node_modules`, each package's `dist` directory, and `packages/web-frontend/out`. Those dependencies contain workspace links relative to the source tree. Compare the transfer's checksum on both machines and record the accepted source commit and deploy receipts.

Declare the CT change through host-steward, run `st sessions may-disrupt aico` on the workstation, and install as kasadis in CT 190:

```
AICO_INSTALL_SOURCE_SHA=FULL_COMMIT bash scripts/install.sh --prebuilt --start
```

`--prebuilt` checks the required bundles, static page and dependencies before installing files; it runs no dependency install or build. The normal installer then installs the CLI, Tether, units and extensions and starts the existing Aico services. Keep CT 190's existing configuration and data. The release directory must be named with the full source commit.

Afterward verify web health, Tether health, active unit paths, a synthetic Logins entry reaching both peers and its removal reaching both, the CT's own append-only backup job, and its heartbeat Status row. Read metadata only; never reveal the entry's value.

Rollback uses the retained prior release's installer and bundles. Restore its unit and launcher targets, retaining the newer data; no database restore or backup deletion is part of a code rollback. M12's pre-change CT release was `39913f44db68330972f9e8fbe659405cb30794ba`, with the ops command release `81c420942578911be67b57ee16d3f7fc5d85022f`.
