# M10c-2a verification record

Complete. Remaining: None within the agreed scope. Aico owns the backup schedules. The four legacy timers are disabled, their files remain, and all Aico backend runs passed. `live-proof.json` contains the final run receipts, source/target rows, Status rows, job schedules and timer state.

Migrated once from SummitFlow: 65 source records, 2 backend records, 2 external checks and the exact excludes. Runtime code does not query SummitFlow's configuration database. Existing btrbk settings remain authoritative for T7 retention; restic and work-snapshot retention preserve the previous selection and qualification rules. Freshness uses the newest restorable data time, including conservative imported and offline-source handling.

Each machine's Aico SQLite databases and photos are covered hourly by append-only CT160 copies and daily by Drive. CT190's daily Drive capture remains workstation-owned; its own hourly append copy runs independently. The hourly SQLite snapshots use consistent database backups and integrity checks.

Source checkpoints: 5930fe31 (engine/screen), b1d46038 (schedule, committed by the publication lane to resolve named-writer attribution), f657ca9a and 16dabd10 (retention/recovery compatibility), 11d3a836 (native staging, imported qualification, boot handling and deploy ordering/rollback), 61ca1da1 (root-owned native reads), b00048f6 (Redis authentication). Across these source/config/test checkpoints: +5508/-118 text lines, 39 files; generated evidence is excluded. Shared edits preserve the publication and Logins lanes' work.

No existing backup keys, passwords or Drive auth were changed. The agent never opened credential contents, printed secrets or inspected environment dumps. Redis capture uses the previous engine's existing credential-file reference at runtime and passes only its password to the client environment, never argv or logs. The authenticated deployed capture returned exit 0 and no stderr; its payload stdout was discarded for that probe.

The coordinator conveyed explicit owner approval for CT190's own append-only credential and independent CT160 repository. That setup created only the new client credential and repository, with the secret directory 0700 and files 0600. Its forced command reaches the fixed append-only repository. Existing credentials and repositories were preserved. The coordinator received only host/path metadata and owns the password-manager handoff. No secret bytes were displayed. Nightshift declarations cover the host configuration and package setup.

Required review: `review-codex.md`, one Codex subagent, eleven concrete findings fixed with failing regressions first. Coverage includes physical snapshot aliases, independent receipts, frozen-tree classification, nested completeness, project baselines, source qualification, data-age migration, restore bounds and byte checks, stream paths, root auth-copy replacement and boot/package timing. Live defects in native staging, boot connection handling, ops promotion, root-only reads and Redis auth also received reproductions and regression coverage.

Acceptance before: pinned 23937172237deb969d2f95ea66d19823715a944f passed; receipt `.git/st/acceptance/b22733791fe46868a33e9ee3b0ba9924afb88cd7dff19f4862cfed834a7488d1.json`.

Acceptance after: b00048f6679bcf9175ef56489dbd71a1867acc54 passed, 3375 JavaScript and 1153 Python tests; required type/lint/boundary/UI checks clean. Receipt `.git/aico-checks/receipts/accept-3ddf4a7219739e853174a13a851e2a7a3ae543c7.json`. Quick gates passed at each checkpoint. The legacy ST acceptance wrapper refused unrelated prepared-config drift from another lane; the supported Aico facade checked exact committed trees in isolated worktrees instead. Native stages reused unchanged inputs.

Deployment: this lane ran the required may-disrupt check and managed rebuilds for 16dabd10, 11d3a836 and 61ca1da1. The sidebar lane then deployed the combined accepted descendant ed5bda90337ec85e370a1e372a4ea8293ffba68c with the Redis fix (job aico-167793cf9e39); the Logins lane installed that same source on CT190. Both installed ops links were checked live. Combined acceptance receipt: `.git/aico-checks/receipts/accept-fd756f4c9664cd420a2d2e3c9e26d73e203a1c84.json`. The final deploy result, live journal, health 200 responses and active web/jobs units confirm success. Backup operations survived the web/jobs deployment in their independent units.

| Live proof (UTC, 2026-11-05) | Result |
| --- | --- |
| T7, 01:13:01–01:13:31 | Six received volumes, readonly identities verified, recovery metadata published |
| Drive, 01:53:38–01:58:20 | Full clean rerun, including authenticated Redis |
| Workstation append, 01:58:21–01:58:24 | Clean CT160 append-only copy |
| CT190 append, 01:13:31–01:13:33 | Clean independent CT160 append-only copy; next hourly run present |
| Work snapshots, 01:55:54–01:55:56 | Clean; previous clean run also recorded |
| Guard, repeatedly | Clean; latest final-proof run 02:01:00 |
| Read-back, 01:40:58–01:52:30 | Configured 500M sample passed |

The first Drive run found the Redis auth omission; every other copy passed. The clean rerun above supersedes it. Drive and read-back verification were run without `--scheduled`, so neither invoked manual retention. No prune/forget was run by hand. No backup data or snapshots were deleted beyond the existing configured automatic policy. An earlier T7 partial capture was left intact when its receipt publication failed; the following clean run retained the installed root helper's original staging contract.

Restore: through the actual UI, selected Aico's T7 snapshot, browsed its folder, and restored `project.identity.json` into the new `/srv/scratch/aico-m10c-2-restore` folder. The engine compared bytes with `diff`; independent `cmp` returned zero (1574 bytes). `restore-proof.json` records the paths, digest and comparison. No restore targeted durable data.

Final Status: 134 unique source/target rows, 125 current, 8 archived/off, one external failure. Every active Aico backend row is current. The external Portfolio backup owner VM remains stopped (`qm status 180`, checked live); the missing artifact proof stays visible rather than being suppressed. This external owner's schedule is outside Aico's runner.

Rendered evidence: list and restore screenshots at 1600x900 and 390x844, with matching `*-uilint.txt` files reporting zero violations. All four images were visually reviewed. Search, snapshot selection, folder browsing, file selection, destination entry and successful restore were exercised. Both viewports fit without horizontal document overflow. Uilint is mechanical evidence, not design approval.

Cutover occurred only after all required clean receipts, at 01:59:01–01:59:03 UTC. Nightshift declaration attributed the timer/config changes before execution. `summitflow-host-backup.timer`, `btrfs-autosnapshot.timer`, `summitflow-host-verify.timer` and `summitflow-backup-window-guard.timer` are disabled and inactive; every FragmentPath still exists. Aico's seven backup jobs remain registered with their next runs. `rollback.md` explains removing only workstation Aico backup schedules and re-enabling the preserved timers, while retaining CT190's independent append job.

M10c-2b disaster-recovery scripts and restore drill were not started. Neri repositories, case data and hunting sessions were not opened. Publication was not requested or performed.
