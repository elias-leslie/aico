# Retired units removed (2026-11-06)

Installed unit files of retired services were the reason two retirements came undone (review headlines 1 and 2): an Agent Hub rebuild re-rendered and re-enabled its retired units, and a stale `tether-link@.service` crash-looped 5,244 times. Their sources stay in their repos and in the pre-Aico archive; only the installed copies were removed. Declared first: `nightshift declare --what units` on davion-sidarli, davion-gem and aico.

Before removing, each unit was checked: `is-active` (none active), `is-enabled` (disabled or static; templates had 0 instances), `WantedBy`/`RequiredBy`/`TriggeredBy` (all empty) and `list-dependencies --reverse` (nothing; `nightshift-desktop-approve` only lists its own `PartOf=graphical-session.target`). A grep of Aico's code and kept units found only host-steward's `checks.toml` naming them, as counterparts and trusted-unit labels; a missing counterpart counts as off, so no controller changes. Then `daemon-reload` in each manager.

## Agent Hub rebuilds

- Cause: `agent-hub/project.identity.json` listed the frontend, Hatchet workers, usage-collect timer and Codex session sync/close timers; every `st service rebuild agent-hub` rendered and enabled them. Fixed in agent-hub `99a949b9` (backend only, `runtime.frontend_build: false`) and aico `b18b373b` (service tools honour `frontend_build: false`: no frontend build, no page probe on the backend).
- Verified by a real rebuild (job `48df2f25`, release receipt `ad68b1e0`): phases ran with `frontend_build` skipped (0 s), `restart` touched only `agent-hub-backend.service`, health passed. Afterwards all six retired units are `not-found`/inactive; backend active, `/health` 200.

## Workstation, user manager (35 files, 4 drop-in folders)

- Agent Hub: `agent-hub-frontend.service`, `agent-hub-hatchet-agent-worker.service`, `agent-hub-hatchet-ops-worker.service` (+ `.d`), `agent-hub-usage-collect.service`, `agent-hub-usage-collect.timer` (+ `.d`), `codex-session-close-inactive.service/.timer`, `codex-session-sync.service/.timer`.
- Nightshift: `nightshift-app-adb.service`, `nightshift-couriers.service/.timer`, `nightshift-daily-pass.service/.timer`, `nightshift-decide.service`, `nightshift-desktop-approve.service`, `nightshift-digest.service/.timer`, `nightshift-drill.service/.timer`, `nightshift-memctl.service`, `nightshift-notify-critical.path/.service/.timer`, `nightshift-web.service` (+ `.d`).
- SummitFlow: `summitflow-backend.service` (+ `.d`), `summitflow-frontend.service`, `summitflow-hatchet-worker.service`, `summitflow-host-backup.service/.timer`, `summitflow-host-verify.service/.timer`, `btrfs-autosnapshot.service/.timer` (ran `st autosnap`, a retired SF verb).
- Tether: `tether-link@.service`, the Oct 30 ssh unit that ran `tether link` (now exit 2). `scripts/install.sh` no longer installs the template and removes a leftover copy (aico `2358a4d0`), so CT 190 loses its stub on its next install.

## Workstation, system manager (42 files, 3 drop-in folders)

- Nightshift: `nightshift-agent-requests.path/.service/.timer`, `nightshift-approvals.path/.service/.timer`, `nightshift-approve.service`, `nightshift-btrfs-scrub-native.service/.timer`, `nightshift-btrfs-scrub-root.service/.timer`, `nightshift-check.service/.timer`, `nightshift-collect-usage.service/.timer`, `nightshift-coord@.service`, `nightshift-exec@.service`, `nightshift-fcm-token.service/.timer`, `nightshift-grant.service`, `nightshift-housekeeping.service/.timer`, `nightshift-nvme-long-test.service/.timer`, `nightshift-nvme-short-test.service/.timer`, `nightshift-outbox.path/.service/.timer`, `nightshift-runner-critical.path/.timer`, `nightshift-runner-monthly.timer` (+ `.d`), `nightshift-runner-nightly.timer` (+ `.d`), `nightshift-runner-weekly.timer` (+ `.d`), `nightshift-runner@.service`, `nightshift-space-guard.service/.timer`.
- SummitFlow: `summitflow-backup-window-guard.service/.timer` (Aico's `backups-guard` job replaces it; the `/usr/local/sbin/summitflow-backup-window` script it calls stays), `summitflow-host-monitor.service`, `summitflow-stack-prune.service/.timer`.

## davion-gem (3 files)

`nightshift-nightwatch.service/.timer`, `nightshift-nightwatch-web.service` (replaced by `aico-pve-sender`/`aico-pve-trim` timers).

## Kept (live use)

| Unit | Why |
| --- | --- |
| `agent-hub-backend.service` (user) | Neri still uses Agent Hub |
| `summitflow-stack.service` (system, disabled) | bootstrap of the stack whose Postgres container stays up for AH and Neri |
| `neri-backend.service` (user) | Neri |
| `nightshift-display-guard.service`, `nightshift-postboot.service/.timer` (user) | display shutoff; post-boot restore check |
| `nightshift-boot-mark.service`, `nightshift-input-watch.service`, `nightshift-zswap.service` (system) | boot marker, physical input stamp, zswap |
| `run-nightshift\x2dsigning.mount`, `summitflow-dnsmasq.service` (system) | release-signing tmpfs; split DNS |
| gem `nightshift-boot-mark.service`, `summitflow-cpu-epp.service` | boot marker; CPU EPP |

Not touched: other projects' units (portfolio, vantage, test1-3 drop-ins and so on) and `~/.config/systemd/user/.managed-unit-manifests`.

## CT 190 updates (signed Tether push and full release)

- Cause of "No usable signed release": nothing ever ran `tether fleet sign-update`, so the workstation's Tether lib had no `signed-update.json` to send. `install-release.sh` now signs the installed lib wherever the update signing key is held (aico `2358a4d0`); the hub's failure line now says why.
- Before: CT 190 on hand-installed `b8c2b31d`, Tether bundle `369d9305…`, stale `tether-link@.service` present; workstation journal last logged the failure 08:32.
- After the `tether@default` deploy at `94598f7a` (09:43) the lib carried a fresh `signed-update.json`; `tether fleet push-update aico ~/.local/lib/tether` installed through the signed path, and CT 190's bundle matched the workstation's (`b75bad59…`).
- `scripts/deploy-remote.sh aico-gem` then put the workstation's accepted release `834cd6bb` on CT 190: copy checked, `install.sh --prebuilt --start` ran, ops link = `834cd6bb`, `aico-web`/`aico-jobs`/`tether@default` active, `/health` 200, `tether-link@.service` gone.
