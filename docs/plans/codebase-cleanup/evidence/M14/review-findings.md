# 4.2 Opus review findings (2026-11-06), pending live validation

## agent/chat/context/web
1 C context-unused never fires: web-server/src/context.ts:64-73,110 saves wrong history id on 404; cost.ts:182 group incomplete -> row always amber
2 C failed Status rows tray-only, late -> phone: web-server/src/status-actions.ts:262 (131182c8); also removed failed-row Needs-you unless owner_only
3 C web search --timelimit fails: DDG lite 202 challenge, Bing refuses recency; webtools/src/search.ts:133-136,182-190; zero results reported as failure
4 C test-chat asks land in owner Needs you; started_by unused (agent/src/transcript.ts:118; web-server chat.ts, api.ts:205-230)
5 C chat ask needing files: chat.ts:193-194 no files -> 409; drawer api.ts:446-453 drops ask.files
6 C queued chat msgs stranded after failed/swapped (agent/src/chats.ts:546)
7 C agy prompt >128KiB argv E2BIG reported "not installed" (agent/src/ask.ts:322, :160-166)
8 P always-on rules flagged unused (context/src/cost.ts:227-232)
9 C ContextPage.tsx:43,97,129 raw ids + "UTF-8 bytes ÷ 4"

## checks/cli/publish
1 C publish pushes unchecked ancestor commits; quick check counts as proof (checks/src/publish.ts:42-46,152; commit.ts:183)
2 C failed swap recovery reported warn (ops/src/deploy.ts:963,971, catch :820-826)
3 C Codex subagents never finished in _coord native_children, grows forever (native/hook/lease/children.go:83,100)
4 P pve trim holds main sender lock (native/pve-sender/pve_sender/cli.py:45-47)
5 C one failed status post aborts publish pass (publish.ts:181)
6 C hold --through REV never publishes REV (publish.ts:144)
7 C proxmox token refetched per call -> audit spam (ops/src/vm.ts:47-56)  [in Logins fix]

## fleet/logins/root
1 C Logins audit unbounded, snapshot 2.80MB vs 4MiB cap, ~16h  [FIX RUNNING]
2 C CT190 notify-outbox can't read phone pairing; floor alarm stuck (install-ct190.sh:17, watchdog.py:108-118)
3 C canary: no cooldown/rate limit/event store (web-server/src/canary.ts:89-103)
4 P Logins dir lock no stale handling (logins.ts:193-206)  [in Logins fix]
5 C power check ssh to gem every 5s, 300s timeout (fleet/src/fleet.ts:404-413)  [in Logins fix]
6 C CT190 fleet.json lacks proxmoxSsh -> late rows for off workers
7 C grant rows accumulate forever (host_steward/grants.py:83-100)
8 P second root handler in peer router (tether/src/server.ts:457)
note: lab assignment trusts self-reported ST_WORK_ROLE (by design per neri-switch)

## ops/backups/archive
1 C backup rows late at run start -> real phone pushes (ops/src/backups.ts:551-555; status show.ts no grace); CT190 stays late
2 C pressure snapshot prune dropped (checks.toml reclaim_commands=[]; backup-retention.ts pressure=false)
3 C st rollback restores with no preview/confirm (cli/src/main.ts:55)
4 C recovery.md: password kinds, /logins path, no workstation+T7 loss procedure
5 P archive counts differ from cutlist (notifications 741 vs 1680)
latent: backup-drive.ts requires summitflow postgres stream

## Rex remote-ahead (done): fleet row stale (fleet/src/service.ts:59-80, settings.ts:41-77), add network-online, stale tether-link@ unit installed, docs stale; origin Access JWT check suggested
- Aico still reads phone gate/devices seed from /var/lib/nightshift/web (web-server/src/config.ts:210,373): move to Aico state

## post-handoff Codex commits (50c787c3..HEAD)
1 C root's wait silently cancelled when helper ends lane (lane-reports.ts:1135-1155,1210 -> waits.ts:928-940)
2 C repeat create for ended/exited root -> 409 at_capacity (hub/placement.ts:1088-1104; test weakened needs(100)->needs(1); api-v1.md:1113)
3 P late confirm vs tick double finish()/respawn (recovery.ts:799-820, ~1150-1170, :515)
4 C remote-root bookings never restored; docs overclaim (placement.ts:586-606; reboot-continuity.md; recovery-readiness doc pt 4)
5 C restoreFinished never resolves with stuck pending -> dead shells never cleaned (reboot.ts:347-371; dead-shells.ts:68)
6 C transfer re-sends [Ask] filed notices (asks.ts:736-746)
docs: api-v1.md:720 stale; End-cancels-waits undocumented; transfer test bypasses route; confirmAgent strict mismatch (P)
open: does Neri entry map crashes to exit 75 (bypasses crash-loop limits)? -> ask Neri coordinator

## Rex research findings to act on (docs/rex-comparison-2026-11-06.md)
- status: blocked/waiting session only reaches tray (2 min), never phone unless --blocking ask; startup trust dialog shows "No status"; non-blocking asks not on session row; no "working, quiet N min" signal
- guard gaps: allows rm -rf ~/.local/state/aico/backups, SQL drops, python/node deletes, `cat auth.json | curl`; agy sessions have no hook
- help: `st aico`, `st aico --help`, `st aico list` print aico-root-watch.py usage; `tether ask create --help` errors
- terminal: log reseeds (onReseed unset in terminal.ts); no WS compression; alt-screen seeds send full history; phone history budget
- remote: origin never verifies Cf-Access-Jwt-Assertion (api.ts:461-467)
- possible: blocking asks push through Nightshift CLI, not Aico notify.db (unconfirmed)
