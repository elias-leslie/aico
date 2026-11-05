# PVE thin pool growth on davion-gem (read-only investigation)

Host: `davion-gem`, pve-manager 9.2.24, kernel 7.0.14-26-pve. Pool: `pve/data`
(831.36 GiB) on a 952 GiB VG whose **free space is 0 GiB**, so the pool cannot be
grown without first shrinking something. Measured 2026-11-04 21:13–21:18 EST.

Nothing was deleted, pruned, resized, activated or mounted. Guest filesystem
inspection was limited to running containers (`pct exec`); VM 201 (neri-hunters)
and the Neri VMs (120/121/123/124/125) were left entirely alone, sizes only. No
credentials were read.

## Headline

The reported "65.2 %, ~1.1 %/day, full in ~24 days" was true until 2026-11-04
11:14. A cleanup that afternoon (12 VM snapshot deletions + destroy of VMs 111
and 192) freed **154.0 GiB**, so the pool now sits at **394.0 GiB used / 47.4 %**
with **437.4 GiB free**.

The growth was never a slow leak. It is step growth produced by the agent/hunter
workflow: every slice takes a fresh named snapshot of a 151.5 GiB agent disk
(VM 201, and VM 200 before it), each snapshot pins a COW delta, and deltas
accumulate until someone deletes the snapshots. When no hunter VM runs, the pool
is flat (0.0–0.1 GiB/day).

| Window (from PVE storage RRD) | Δ pool | What ran |
| --- | --- | --- |
| 10-28 22:30 → 10-29 21:30 | +2.5 GiB | idle, no tasks |
| 10-29 21:24 clone of 9001, `resize 200`, 3 snapshots of 200 → 10-30 12:00 | +23.6 GiB | VM 200 snapshot churn |
| 10-30 12:00 → 10-31 11:00 | +0.0 GiB | idle |
| 10-31 11:23 full clone 200 → 201, then 15 snapshot/delete cycles on 201 → 11-01 09:00 | +32.7 GiB | VM 201 churn |
| 11-01 09:00 → 11-01 19:00 | +23.6 GiB | 7 more snapshots of 201 |
| 11-01 19:00 → 11-02 17:00 | ±0.0 GiB | hunters off |
| 11-02 17:19 `vzcreate 190` → 21:30 | +6.9 GiB | CT 190 rebuilt |
| 11-02 21:30 → 11-04 11:00 (37.5 h) | +0.3 GiB | idle |
| 11-04 11:14–11:21 cleanup | **−154.0 GiB** | 12 snapshots deleted, VMs 111 + 192 destroyed |
| 11-04 17:30 → 21:15 | +5.3 GiB | VM 180 boot/shutdown, VM 200 start, 2× vzdump 150 |

Net 10-28 22:30 → 11-04 11:00: **+89.5 GiB in 6.52 days = 13.7 GiB/day (1.65 pp/day)**,
which is the rate the coordinator saw. Per-day rates to plan with:

- idle (VMs off, no hunter work): 0.1–2.5 GiB/day → ~6 months of headroom
- hunter/slice day (11-01): +26.3 GiB/day → **437 GiB / 26.3 ≈ 16 days to full**
- averaged over the last week: 13.7 GiB/day → **~32 days to full**

So the 24-day style estimate is right *only while slice snapshots are taken and
never deleted*; it is wrong as a "the pool leaks by itself" statement.

## Per-volume usage

`lvs -a` reports `Data%` only for active thin volumes. Active volumes (running
guests, plus 201 which its snapshots keep active):

| Volume | Guest | Size | Data% | Used GiB |
| --- | --- | --- | --- | --- |
| `vm-100-disk-0` | VM 100 st-browser (stopped) | 100.0 | 78.51 | **78.5** |
| `vm-160-disk-1` | CT 160 restic-append `/srv/restic` | 150.0 | 42.54 | **63.8** |
| `vm-201-disk-0` | VM 201 neri-hunters (stopped) | 151.5 | 34.80 | **52.7** |
| `vm-180-disk-0` | VM 180 apps (stopped) | 63.5 | 45.73 | **29.0** |
| `vm-200-disk-0` | VM 200 agent-work (running) | 151.5 | 10.24 | **15.5** |
| `vm-190-disk-0` | CT 190 aico | 32.0 | 22.17 | **7.1** |
| `vm-150-disk-0` | CT 150 ominull-hub | 64.0 | 7.30 | **4.7** |
| `vm-170-disk-0` | CT 170 opencanary | 4.0 | 36.09 | **1.4** |
| `vm-160-disk-0` | CT 160 root | 4.0 | 20.98 | **0.8** |
| 4 × cloud-init | — | 0.004 each | 9.38 | 0.03 |
| **total active** | | | | **253.6** |

Guest filesystem cross-check (`pct exec … df`) agrees with the LV figures:
CT 150 3.5 GiB used, CT 160 0.7 GiB root + 61 GiB `/srv/restic`, CT 170 1.3 GiB,
CT 190 6.4 GiB.

**394.0 GiB − 253.6 GiB = ~140.4 GiB (35.6 % of pool) is not attributable to any
active volume.** It sits in the 19 inactive (non-activated) thin LVs plus 11
stopped-guest disks, all of which report no `Data%` while inactive:

- 17 guest snapshots — `snap_vm-100-disk-0_clean-base` (2026-03-16),
  `snap_vm-110-disk-{0,1,2}_baseline-clean`, `snap_vm-112`, `snap_vm-120`,
  `snap_vm-121`, `snap_vm-123`, `snap_vm-124`, 3 × `snap_vm-150-disk-0_*`
  (2026-09-03), `snap_vm-180-disk-0_pre-app-install-20261020`,
  `snap_vm-190-disk-0_m11b-before-final` (2026-11-04), 1 × 200, 2 × 201
- 2 template bases: `base-9000-disk-0`, `base-9001-disk-0`
- 11 stopped guests with inactive origins: 110, 112, 120, 121, 123, 124, 125,
  130, 140, 9000, 9001
- thin metadata: 2.02 % of 8.32 GiB = 0.17 GiB

Splitting that 140 GiB further would require activating the LVs (`lvchange -ay`)
or a metadata snapshot (`thin_ls` refused: "Device or resource busy" / bad
superblock), both of which change state, so it was not done. What the 11-04
cleanup proves is the magnitude: deleting 11 snapshots of 201 + 1 of 100 and
destroying VM 111 (50 GiB disk) and the 192 clone released 154 GiB, i.e. those
snapshot deltas alone carried roughly 110–120 GiB.

## Top growers and why

1. **VM 201 neri-hunters slice snapshots — the dominant grower.** 29 `qmsnapshot`
   and 26 `qmdelsnapshot` tasks between 10-31 11:32 and 11-01 18:09
   (`qmclone 200 → 201` at 10-31 11:23 is the origin). The deleted names on 11-04
   are slice-scoped, not release-scoped: `p2a-helper-ready`,
   `p2a-baseline-verified`, `p2a-api19-verified`, `p2a-auth-storage`,
   `p2a-auth-storage-clean`, `clean`, `clean-p2a-20261101`,
   `clean-v1-a8670e5-api25`, `clean-v1-14db16b`, `clean-b4-2c97de1`,
   `clean-shim-f6fc761`. Each snapshot of a running hunter freezes a COW delta of
   several GiB; while a snapshot exists, every further write keeps costing pool
   space in both the snapshot and the origin (double accounting), and
   `qmrollback` (8 rollbacks on the host this week) only makes it worse because
   it rewrites the whole 151.5 GiB mapping.
   *Fix:* keep exactly one `clean` snapshot of 201 (the documented revert point,
   currently `clean-toolset-50537ab`); delete slice snapshots the moment a slice
   is accepted rather than at the next cleanup sweep; take slice checkpoints with
   `st vm rollback` targets only, or use a throwaway full clone
   (`qm clone 201 <id> --snapname clean --full 1` → run → `qm destroy`) so churn
   lives in a disposable disk instead of the shared one. Expected: caps 201's
   snapshot overhead at ~10 GiB instead of 110+ GiB.

2. **VM 200 agent-work snapshot + running writes** — `snap_vm-200-disk-0_signed-in-rust`
   (2026-10-30) plus a running 151.5 GiB disk at 15.5 GiB. It absorbed +13 GiB in
   the 10-29/10-30 churn window and grows whenever agents build in it.
   *Fix:* keep `signed-in-rust` as the only 200 snapshot, `st vm rollback 200
   signed-in-rust` after a slice instead of stacking new ones, and shut the VM
   down when idle (it is `onboot: 0`; it was started 20:53 today and stays running).

3. **CT 160 restic-append (63.8 GiB LV / 61 GiB repo, 1986 snapshots, 3755 pack
   files).** Gross new pack data is ~1.0–2.8 GiB/day (11.1 GiB over 10-20…10-26);
   weekly maintenance on 11-01 removed 517 of 2501 snapshots and repacked. It is
   declared "FIRST THING TO SHRINK" in `/root/RESTIC-APPEND-README.txt`; the T7
   and Google Drive copies remain. Note the policy has
   `"aico-pre-tether-archive": 3650` (a 10-year window), the obvious first knob.
   *Fix:* lower that (and any other long window) in
   `/etc/restic-append/policy.json`, run
   `pct exec 160 -- systemctl start restic-append-maintain`, then shrink `mp0`
   (`pct set 160 -mp0 local-lvm:vm-160-disk-1,mp=/srv/restic,size=100G`) and run
   `fstrim` inside the CT so the freed blocks actually return to the pool
   (see item 6 — without a trim the LV never gives anything back).

4. **VM 100 st-browser (78.5 GiB, 20 % of the pool) — largest single active
   volume and the least used guest.** Warm Chrome/Docker browser runtime, stopped
   with `onboot: 1`, snapshot `clean-base` from 2026-03-16. It is not a grower,
   it is parked ballast.
   *Fix:* if the managed browser capability is not in use, roll it back to
   `clean-base` (or destroy and keep the template recipe) — up to ~70 GiB in one
   step. Do this after item 1, and only with owner sign-off, since it is
   `onboot: 1`.

5. **Stopped VMs with big inactive disks** — VM 130 st-ci-runner (71.5 GiB),
   VM 121 neri-gitlab (64.5 GiB disk + `clean-neri-gitlab` snapshot), VM 110
   wfp-target-win11 (50 GiB + baseline snapshot). Their usage cannot be measured
   without activating them; each nominal size is 12–17 % of the pool.
   *Fix:* mark the still-needed ones `template`, and destroy the retired
   installer-test targets (VM 100's own comment already says installer test
   containers were retired 2026-09-15). VM 121/123/124/125 are Neri lab data —
   owner decision, do not touch from cleanup work.

6. **No discard anywhere — the real reason the pool only ratchets up.** CT
   `rootfs`/`mp0` lines carry no `discard=on` and `fstrim.timer` in CTs 150/160/
   170/190 has never run (`list-timers` shows NEXT `-`, LAST `-`). Inside VM 100/
   180/200/201 `discard=on` is set, but the guests only return blocks if they
   issue discards. So restic prune deletions, log rotation and deleted
   checkouts free *guest* space and never free *pool* space.
   *Fix:* run `pct exec <ct> -- fstrim -av` (or add `discard=on` to the
   `rootfs`/`mp` lines at the next scheduled stop) for CTs 150/160/170/190, and
   confirm `fstrim.timer` is actually active in each guest.

7. **Not growers, for the record:** CT 170 opencanary 1.4 GiB (36 % of a 4 GiB
   disk, 8.9 MiB of logs, `logrotate` active) and CT 190 aico 7.1 GiB
   (`/home` 4.0 GiB, `/var` 0.4 GiB) are small and stable. `vzdump 150` runs
   every few hours with `--compress 0` and writes 3.45 GB tarballs into
   `/var/lib/vz/dump/<random>/`; those live on `pve-root` (94 GiB, 36 GiB used,
   also `/var/lib/vz/import` 9.5 GiB + `/var/lib/vz/template` 11 GiB), **not** on
   the thin pool, and the orchestrator removes them — but they are on the same
   zero-free VG, so they are worth watching. Host `/var/log/journal` is capped at
   2 GiB. The ~200 logind "Removed session" lines per hour are session churn from
   the forced-command SSH path, not a space consumer.

## Recommended order (all owner-gated, none executed here)

1. GC VM 201 slice snapshots down to one `clean` — expects ~100 GiB back, no data
   loss (the clean revert point stays).
2. Trim the containers (`pct exec … fstrim -av`) — makes all later deletions
   actually visible to the pool.
3. Lower the restic retention window(s), run maintain, shrink CT 160 `mp0` to
   ~100 GiB — expects 20–40 GiB.
4. Roll VM 100 back to `clean-base` or retire it — up to ~70 GiB, needs owner
   sign-off because it is `onboot: 1`.
5. Decide on VM 130 / VM 110 (and the Neri VMs with the owner) — 50–71 GiB each.
6. Add a pool alert at 80 % and re-measure; at the observed idle rate 437 GiB of
   headroom is ~6 months, but a single slice-heavy day costs ~26 GiB.

Evidence sources: `lvs -a`, `vgs`, `pvesm status`, `pvesh get
/nodes/davion-gem/storage/local-lvm/rrddata --timeframe week|hour`, `pvesh get
/nodes/davion-gem/tasks --limit 400`, `/var/log/pve/tasks/6/*` (snapshot delete
logs), `/etc/pve/{lxc,qemu-server}/*.conf`, `/etc/pve/storage.cfg`,
`/root/RESTIC-APPEND-README.txt`, `/var/lib/restic-append/status.json`, `pct exec`.
