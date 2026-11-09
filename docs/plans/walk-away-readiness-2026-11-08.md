# Walk-away readiness, Nov 8

The owner authorized finishing the read-only review's recommendations. Preserve the
interrupted Claude work; prove defects before fixing them. No publication.

## Work

- Finish Aico's interrupted backup, scheduled Status and time-formatting changes;
  verify, review and commit each checkpoint before one combined deployment.
- Fix Dadbot's four demonstrated Money History review failures using synthetic
  records; preserve real records and deploy after review.
- The owner stopped the overlapping Drive runs at 15:54 EST. Preserve their last
  good copies and backup history. Complete the subsequently approved seven-part
  backup simplification and thermal protection work below before resuming backup
  verification. No backup deletion or pruning without owner authority.
- Apply the owner's established record-only rule for gem's known corrected-memory
  reporting, including spikes; keep uncorrected-error detection working.
- After backup-dependent work, perform a controlled gem reboot and verify recovery.
  This does not prove recovery from a power cut.
- Apply the owner-approved Proxmox VM and container states in
  `proxmox-guest-states-2026-11-08.md`. Make VM 100 start automatically for agent
  browser work and shut down when unused. VM 180 can remain off: its replacement
  backup path reads a temporary hypervisor snapshot without starting the guest.
- Restore Cinderwake's missing voice environments before its next use; remove the
  abandoned proof-stuck routine. Inspect documented remaining risks without expanding
  into unrelated redesigns, updates or private records.

## Resource constraint

Gem has been hot during concurrent backup work. Do not start overlapping guest
captures, installs or builds there. Use managed admission for checks and builds;
run CPU-heavy development checks on the workstation. Inspect live temperature and
workload before adding load. Reuse configured limits rather than inventing new ones.

## Verification and ownership

- Root: integration, time/copy checkpoint, memory-warning policy, backup and space
  inspection, guest inventory, live verification and final report.
- Aico schedule worker: scheduled Status rows and phone-list synchronization.
- Aico backup worker: reboot-interrupted backups and true-failure reporting.
- Dadbot worker: History compatibility, event identity and notes.
- Fresh independent review before each meaningful deployment.

Update this record with verified checkpoints and remaining work; remove only this
work's ROADMAP line when its agreed scope is complete.

## Verified checkpoints (updated 18:37 EST)

- Aico time formatting, schedule deadlines, reboot-cut backup receipts, phone
  synchronization and standalone-agent heat delivery are committed and deployed
  on both controllers. Final phone checkpoint `ce3876bd` and delivery checkpoint
  `a9532b08` passed focused tests and independent review. No test phone pushes.
- Dadbot `475ab5af` is deployed: 636 tests passed; changed live source hashes match,
  application and tunnel recovered after the gem reboot. Real records were not
  rewritten. Exact historical splits cannot be recovered from ambiguous old rows.
- Gem's known corrected-memory reporting remains record-only, including spikes;
  uncorrected-error detection remains enabled. Do not reopen the false ECC warning.
- BlackBox is on with autostart, as requested. Its health check passed after reboot.
  The asset registry's old parked setting was subsequently found and corrected in
  source; both controllers now run the corrected checkpoint and live registry
  verification passed.
- Cinderwake's three pinned voice environments are restored. Dependencies/imports,
  61 seeds and reference builds pass. SoX is installed. No acting A/B or new GPU
  rendering is claimed. The abandoned inactive proof-stuck routine was removed.
- Earlier real-user Aico testing created a session, saw its READY reply, and ended
  it; cancel created no session. Evidence: `/srv/scratch/readiness-new-session-test/`.

## Approved backup and thermal protection work: implemented

The owner approved all seven recommendations. Production temperature sampling is
15 seconds locally, with no recurring SSH/sensor scans. Notices use the existing
Aico settings and delivery path; coordinators or active standalone agents receive
host events. Enforcement does not depend on them responding.

1. Gem sources now have CT 190 as their single Drive owner. Workstation sources
   remain workstation-owned; source IDs and old repository histories are preserved.
2. Dispatcher `689fdaad` is installed and hash-verified. QEMU captures use native
   backup locks, freeze/snapshot/thaw and a continuous plain tar stream; LXC uses a
   continuous scoped stream. Repeated gzip/base64 guest-agent chunks are removed.
   Signal and guest-shutdown cleanup passed 164 dispatcher tests and fresh review.
3. VM 180's 10.12 GB app-backup directory includes 9.45 GB of complete weekly
   Portfolio artifacts. These and all backup histories were preserved. Only two
   abandoned generated chunk directories were deleted: 2,264 files / 27,147,948,432
   bytes. Offline snapshot, mount, loop device and temporary lock were removed.
4. Native guard `116bf831` is enabled on gem, before guest startup, and survived
   the controlled reboot. Normal backup CPU budget is 50% of one core, hot 20%,
   critical 10%; hot is 85 C twice, critical 90 C, recovery at or below 80 C.
   These are workload-control thresholds, not claims about a damage temperature.
5. The budget applies to actual backup workers, not whole application guests.
   A host-wide export lock prevents simultaneous controller exports. ST heavy-work
   admission `8cb8d103` reads the same public local guard heartbeat.
6. Durable ordered heat/action/recovery delivery passed injected-event tests and
   actual consumer tests. There is no extra phone sender or preference bypass.
7. Bounded harmless live proofs verified real 50/20/10% cgroup values, overlap and
   critical deferral, recovery admission, LXC scope cleanup, and a running VM's
   snapshot/thaw/lock cleanup. No full backup or deliberate heat test was started.
   Evidence: `/srv/scratch/aico-backup-bounded-proof/`.

Guard visibility inside CT 190 initially failed across its boot-time /run mount.
`168428b5` fixes this with a read-only bind to /mnt and a standard tmpfiles alias.
A real CT restart proved the alias, read-only mount, fresh heartbeat and installed
SDK admission. No new service was added for this.

The two Drive routines are resumed. Verified next runs: standby Nov 8 20:30 EST
(Nov 9 01:30 UTC), workstation Nov 9 04:00 EST. Both were idle after resumption;
no immediate backup was launched. Jobinator's intentional AI pause is preserved.

### Backup incident facts and remaining handoff

Claude's coordinator requested the workstation run at 14:00:02 EST; its child
requested the standby run at 14:12:39. Separate controller locks allowed overlap.
The two gem exporters consumed about 47m40s and 44m57s CPU before the explicit
15:54 stop. The old transport made 1,132 guest-agent/base64 chunk calls. A bounded
synthetic API test reproduced transfer CPU without compression/encryption; no
historical profile exists to quantify encryption's share. Gem was about 87–89 C
and cooled to about 45 C after the stop.

Actual successful snapshots in the old workstation Drive repository were verified
for host files (`2052950e`), CT 190 data (`41346b2e`) and browser state (`e7d19c3e`).
The new standby repository has cluster config (`87ee2057`); the other three await
their first scheduled copy there. This is an incomplete ownership handoff, with
verified earlier coverage, rather than proof of lost backups. Never import old
snapshot IDs into the new repository's receipts. No forget/prune was run manually.

The native backup health check was found to inspect only the local owner's API,
so it misread moved sources as missing. A minimal owner-aware coverage read is
committed in `87d77eae`, `1a023a77` and `cc8b8ede`, reviewed and deployed
on both controllers. Live coverage reads both repositories and the native backup
check reports fresh copies. Read deadlines use the existing transient-unit seam;
current-owner off semantics are preserved. Keep actual copy
coverage separate from each owner's run health and retain repository provenance.

## Controlled reboot and browser lifecycle

Gem reboot completed. Boot ID changed from `9bd79d6a-db02-45ea-a907-10151ec92b79`
to `7461f85b-c0a2-4a13-bb17-48fc83dc6675`. Portfolio's agent cleared the interruption
and deliberately left its newly renamed/resized VM 180 off. The handshakes were
closed after recovery. This proves clean reboot recovery, not BIOS power recovery.

All selected always-on guests returned. Postboot checks passed for BlackBox,
Ominull hub, backup receiver timer/repository, OpenCanary service, Aico/Tether,
Jobinator backend/frontend/database/scheduler and Dadbot web/tunnel/manifest.
No decoy ports, family records, hunter data or paused AI routines were exercised.

Browser pool locking and boot-bound stopping fences are installed on VM 100 and
both controllers. Live testing uncovered a separate severe standby CLI recursion:
when PATH lacked st, browser-st called itself for VM discovery. The recursive
children were stopped after observed memory pressure. Browser commits `5c9b8757`
and `fc957f5e` remove self-fallback, resolve the supported installed ST facade and
return a clear error. Regression tests and the 1,261-test gate passed; both
controllers now run the fixed release.

The patched live test proved cold start, two-controller use, retaining the VM when
only one controller closes, and automatic poweroff after both close/reap. All
created sessions are closed. Root confirmed VM 100 stopped. Independent two-second
resource observation recorded peak 71.875 C, CT 190 peak 767,614,976 bytes / 72 pids,
zero memory-pressure full avg10, no budget breach; observer was removed afterwards.
Evidence: `/srv/scratch/browser-on-demand-live-report.md` and the bounded-proof
resource log. Follow-up browser commit `3355648a` explains lazy startup without
calling the saved session unusable, and answers fixture help successfully. Its
1,261-test gate passed; both controllers now run it and live help exits zero.

## Checkpoint complete (19:05 EST)

Aico `cc8b8ede` deployed successfully on both controllers. The installed native
backup and asset checks pass and their live Status rows were refreshed. An
additional reproduced lost-completion-reply defect (`ea036cf2`, `73258eb4`) is
fixed in the existing jobs runner: the completed Sunday digest now shows OK,
its actual completion and next Sunday's deadline, without resending the digest.
The real lifecycle tests fail before the fix, pass afterwards, and fresh review
confirmed the active-read-loss case. Settled future jobs gain no repeated reads.

Remaining: None within this checkpoint's agreed scope. The separately approved
remote-use shakedown is now executing under its own plan and ROADMAP line.
