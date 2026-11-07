# Aico deployments

From the workstation checkout, commit and check the source, run `st sessions may-disrupt aico`, then `st service rebuild aico --detach`. Tether (tether@default) is a manual worker, but the deploy restarts it whenever the release changes what it runs (packages/tether, or a package it bundles) or the running daemon's API is older than the release's; the deploy log says why, or that it was left running. Restart it alone with `st service rebuild aico --worker tether@default --detach`. Wait for each printed job result and verify health.

## CT 190, the standalone full peer

CT 190 has no Git checkout and too little memory to build. It runs the same commit-named release the workstation built and accepted. It follows the workstation by itself: the aico-jobs job `peer-release` (every 15 minutes on the workstation, `scripts/peer-release.sh aico-gem aico`) sends the release named in `~/.local/lib/aico/releases/.accepted` (the deployer writes it once a release passes acceptance and goes live) whenever CT 190 runs another commit, declaring the change to Nightshift first, then pushes the workstation's signed Tether over the fleet link (`tether fleet push-update`; installed only when it differs and is newer). A release whose deploy built no Tether keeps CT 190's installed Tether (`install.sh --keep-tether`). It waits while a workstation deploy holds the releases lock. Its Status row says what it sent. To send one now, or a chosen commit, run `st sessions may-disrupt aico`, then from the workstation checkout:

```
scripts/deploy-remote.sh aico-gem            # the commit the workstation runs now
scripts/deploy-remote.sh aico-gem --sha FULL_COMMIT
```

It copies the workstation release (the commit's source plus its `node_modules`, built bundles and `packages/web-frontend/out`; no build caches, runtime state, `.env` or auth files) into a **new** `~/.local/lib/aico/releases/FULL_COMMIT` on the CT, unchanged files hard-linked to its current release. It compares every file's checksum against the workstation copy, then runs that release's `AICO_INSTALL_SOURCE_SHA=FULL_COMMIT bash scripts/install.sh --prebuilt --start` and waits for web health. `--prebuilt` checks the required bundles, static page and dependencies before installing files and runs no dependency install or build. The CT keeps its configuration and data. `--dry-run` shows the copy and changes nothing.

Tether alone also reaches peers on its own: a workstation holding the update signing key signs each Tether release it installs, and its hub sends that signed release to a pinned peer whose Tether API is older when their link comes up.

Afterward verify web health, Tether health, active unit paths, a synthetic Logins entry reaching both peers and its removal reaching both, the CT's own append-only backup job, and its heartbeat Status row. Read metadata only; never reveal the entry's value.

Rollback uses the retained prior release's installer and bundles. Restore its unit and launcher targets, retaining the newer data; no database restore or backup deletion is part of a code rollback. M12's pre-change CT release was `39913f44db68330972f9e8fbe659405cb30794ba`, with the ops command release `81c420942578911be67b57ee16d3f7fc5d85022f`.
