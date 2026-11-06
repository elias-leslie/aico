# Differences from the cleanup plan

Updated 2026-11-06 against main at c000d4f9. This replaces the 2026-11-05 version. Every one of the 106 original differences and every M14 review finding was re-checked against the code or the live system (`aico status`, `aico jobs list`, CLI help, files, Proxmox). The original baseline rows are in [the detailed audit](audit.json); the M14 sources are [review-findings](../../docs/plans/codebase-cleanup/evidence/M14/review-findings.md) and [proposal-check](../../docs/plans/codebase-cleanup/evidence/M14/proposal-check.md). "Fixed" means the change is in main (commit given). "Unverified" means the result could not be established, not that data was lost.

## Counts

| | Fixed | On purpose | Still missed | Still cut short | In progress | Total |
| --- | --- | --- | --- | --- | --- | --- |
| Original 106 differences | 31 | 62 | 2 | 9 | 2 | 106 |
| M14 review findings | 52 | 2 | 0 | 11 | 0 | 65 |
| New since 2026-11-05 | 6 | 5 | 0 | 1 | 2 | 14 |

Live now: `aico status` shows 8 problems and 304 healthy rows, all warnings, none failed or unknown. The three biggest changes since yesterday: SummitFlow, Agent Hub and Nightshift are retired and archived; Postgres, Redis and Hatchet are off on the workstation; Neri runs on SQLite.

## Still open

From the original 106 (11):
- Missed: no copy of active repos to the peer host after each commit (failover work, on the roadmap under Next).
- Missed: the `repo` Status row type still exists with no producer (per-repo publication rows cover it); delete the type or build the rows.
- Cut short: scheduled jobs cannot move to another machine when their home is down; all 14 jobs stay bound to their home.
- Cut short: fleet code is still inside Tether's session service (roadmap Next).
- Cut short: the session engine is still 3,340 lines (roadmap Next).
- Cut short: the power-off journey (phone rescue and notes with each machine down) has not been run; planned with the owner.
- Cut short: the Keep import has had a dry run and verify only; the recipe and car-note spot check is not recorded.
- Cut short: the old 14 host registrations have no recorded disposition (3 hosts are linked now).
- Cut short: the project keep-list and history reconciliation is not recorded.
- Cut short: the old root and CI helper scripts have no recorded one-line disposition (VM 130 st-ci-runner still exists, stopped).
- Cut short: the rendered session-list check was never done (the browser failed once); the Haiku user-test round in 4.3 covers it.

New (1): the canary webhook path skips the Access check at the origin (b6a203fd) while the plan record says the owner rejected public callbacks; whether the Cloudflare edge lets it through is not checked. Needs the owner to confirm it is wanted (details under New differences).

From M14 (11):
- `st aico`, `st aico --help` and `st aico list` print the root-watch helper's usage instead of Aico help.
- The startup trust dialog shows "No status" on the session.
- Non-blocking asks do not show on the session row.
- There is no "working, quiet N min" signal.
- Antigravity (agy) sessions may have no guard hook; not confirmed.
- The Sudo use check warns daily: `summitflow-backup-window` ran 289 times against 13 a day (the 5-minute backups guard calls it through sudo).
- Delivered context still names retired systems (3 memories; prompts not counted); the context audit in 4.3 covers it.
- Does the Neri entry map crashes to exit 75 (which skips crash-loop limits)? Unanswered; Neri coordinator's to answer.
- Archive counts differ from the cutlist (notifications 741 vs 1680); the archive is not readable from here.
- `tether@.service` has no wait for network-online (hygiene; the 5 s retry covers it).
- Ended launch lanes showing as open in the session list: not rechecked (`st sessions list` today still shows some old `live-smoke-*` rows as open).

## In progress elsewhere

- OmniNull M1 (one expected-rule model), running in the OmniNull project. Live warnings that belong to it: detection floor drill missed 2 of 85 cases; detection health 3 pages against a budget of 1. The drill fix 7a02bd9 is committed; the warning has not cleared yet.
- OmniNull enrollment of VMs 200 (agent-work) and 201 (neri-hunters), both off now; the check that alerts work after the first ordinary hunting run waits on them. CT 190 already runs the agent; the fleet coverage row reads OK.
- Renaming nightshift.summitflow.dev to app.summitflow.dev: code, Access audience and cert checks use app.summitflow.dev only (01191718, 1fbdda47); the old name no longer resolves and the new one answers. Still waiting on a Cloudflare login: the DNS record and Access app for approve.summitflow.dev.

## New differences since 2026-11-05

On purpose:
- Tasks left Aico: the task tables are dropped (ef9f1f0c); each project's ROADMAP.md and the Projects page replace them. The 38 still-real tasks were carried into those roadmaps (4654b83b, d678c4b4). The plan expected to carry about 13.
- Nightshift's postboot check and boot markers were dropped, not ported; Tether's own restore after reboot replaces them (decision log, ef7ae28a).
- Kept in place on purpose: `/etc/nightshift` secrets (deleting them is the owner's call), the release signer store and FCM token under `/var/lib/nightshift`, and on gem its `deadman` data.
- Root helpers named `summitflow-*` remain in `/usr/local/sbin` (backup window, native capture, snapshot delete, steward receipt) as Aico-owned sources; only the names are old.
- Machine intent in Status (always, on demand, off): a machine turned off on purpose shows Off with its last report, not Unknown (7d12739a, 3037ffe5, 1abe5459, 9aa1fc0f, cd1b2d3a). The plan had no such state.

Fixed along the way (not in the plan):
- Cloudflare Access token checked at the origin on every tunneled request (ee4ecca6).
- Backup checks for Portfolio's artifact and Jobinator's container (c892a6c3, d401d0e7, 43cad446, 824502b5, 75a4b83b); Jobinator reports from its own machine (f4393541).
- Browser profile fixes: closing or reaping the AI browser leaves no Chrome or multi-GB profile copy (browser-automation 7f53fb3, 51508f5, 7d891c3).
- Release pruning keeps any release a live process still uses (a1b66cf0, 779b235f).
- Portfolio dropped Hatchet; its worker schedules its own jobs (portfolio-ai bda14f2a9).
- Projects page and server (2fc677a7, b67a3318, 137cf7c6).

Still cut short:
- The canary webhook path now skips the Access check at the origin (b6a203fd) so phone-host callbacks work, but the plan record says the owner rejected public callbacks. Whether the Cloudflare edge lets it through is not checked here. Needs the owner to confirm this is wanted.

## Fixed (31 of the original 106)

Missed, now done:
- Nightly full check and live checks: `check-nightly` job, gate time in its Status row (4dd4c393, 619d0bcc, 737ef960). Last run: gate 105 s.
- Dead-code and new-suppression guards, with baselines (4dd4c393, 01578e4c, e236b0b4).
- Multi-view hook chain collapsed into one state module (b8f11e85).
- Memory page: list, search, delete on the agents page (0db1126a).
- Per-session context size recorded and shown (cc0933b2, 70e0a018, 30ee87cc).
- Live task carry: tasks replaced by roadmaps (ef9f1f0c, 09b435ba, 4654b83b).
- Portfolio backup showing Failed while its VM is off (0eb6f29c, 3037ffe5, 824502b5, 43cad446).
- OmniNull: own release signer replaces the Nightshift one (OmniNull 5fd4c93); alerts and health pushed to Aico, pull feed retired (bcf902e); old-release-key row (`ominull.builds.*`); fleet coverage row (ae22053); agent running on CT 190.

Cut short, now done:
- Frontend deploys swap the page build without restarting aico-web (223207c4).
- Full check at the time target: 105 s.
- Heavy hook tests trimmed with the collapse (b8f11e85; the 934-line tabs test is gone).
- Dead-code and duplication runs: the audit was wrong; the tool-run evidence exists (evidence/M12-2/fallow-final.json).
- AGY context no longer depends on Agent Hub (031401c0).

On purpose, now closed:
- Opus review of the Codex-built pieces ran (133aa812); its findings are in the M14 section below.
- Agent Hub and PostgreSQL retired and archived (99c5630c, 910cf026, 61ef4112); `st complete` and its extension dropped (031401c0).
- Neri switch note: Neri runs on SQLite and Aico context (owner-stated; Neri data not opened here).
- Publication fully in Aico: outgoing verifier, delivery transport, importers (11e675b2, 3b6a367b, 42f73a9d).
- Old SummitFlow check receipts: the checkout and its state are gone (`~/.summitflow/SummitFlow` is empty); archived in `/srv/workspaces/archive/summitflow-2026-11-06`.
- Reboot and runtime remainders (display guard, input watch, zswap, split DNS, home-off): moved to host-steward (d53e27ce, 3f26f6de, 44accd50, e81bfddd).
- The one Nightshift item and 20 "documents": nothing to carry (they were runtime state); the open critical lab item became an isolation-check rule (4654b83b).
- Old Web Push state, decide database, OmniNull cache: in `archive/nightshift-2026-11-06/state`; `/var/lib/nightshift` is down to the kept signer store and FCM token.
- Automatic snapshot-prune under pressure: back as thinning of work snapshots (2eeb340e).
- Lab isolation warning for VM 111: VM deleted, asset entry dropped (ff95e007, 777d5756), and lab flows past isolation page (4332a359).

## On purpose (62 of the original 106)

Unchanged from the first list unless noted; each one has its reason in audit.json.
- Allowed old exceptions (M0b): 24 direct database imports, 23 import cycles, 2 disallowed package imports, all still exempted (2).
- Left as is, recommended in M14 and not an owner decision yet: separate question schema (the notice schema already has `kind: question`); a check-budget command (gate time is in the nightly row instead); native contract replay beyond the five components that read contracts; the Notes module split (6.7k lines stay in the web server); exact-wording tests (they test the "each state has its own copy" rule); original-equality checks for memories, prompts, sudo and asset baselines (the live rows changed legitimately); asks stay on the host that filed them (tasks sync is moot) (8).
- Tooling choices: related tests instead of full projects, package dependency lists instead of an affected script, same-layer pairs, agent posts through the session client, Python ports for service controls, commit-named releases instead of two links, vitest, one catalog of alias models (7).
- Product choices: Wake button deferred, read-only phone notes cache, three vision photos and no API run, separate limited Drive login, car reminders in Portfolio, twelve job policies and five roles, Logins store, one-time context budget import, daily usage history carried, direct secret migration, owner kept phone pairing, notices on Status and Needs you, phone views grants but approval is desktop-only, tray extension kept, passkeys in the root grant store (15).
- Operational choices: SSH kept for guest power and backup control, sending moved to the Proxmox sender, LAN-only canary (see new differences), drill limited to grants and a synthetic canary, telemetry without the incident table, selected host metrics carried, host commands as `aico declare`/host-steward, bounded cleanup (package caches only; scratch, model and artifact retention deferred), tool manifests kept and old reports dropped, mockups not copied, deliberate omissions of the old delivery drill, Cinderwake and Code Intelligence proofs stopped at known failures (13).
- Left in the archive with the retired projects (old command files, guard fixture, system-monitor, dead files, squashed migrations, Agent Hub workers, frontend, protocol files, docs, migrations, backfills and tests, Nightshift tests, decide modules and ledger, comparison table): all now under `/srv/workspaces/archive` (16).
- Not opened by this effort: the four early Neri entries (1).

## M14 review findings (65): 52 fixed

- Context and chat: context-unused check fires and now reports real findings (a058b09c); failed Status rows needing the owner reach the phone (ef9446c0); web search time limit falls back and zero results is `no_results` (4a2d7021); chat asks route to the session that started the chat, with files (b98e0819, 3f1183da); queued chat messages return to the draft and oversize agy prompts are refused (bd117ec5); always-on rules never counted unused (a058b09c); context page labels (70e0a018).
- Checks and publish: only whole-tree-checked commits publish, a failed Status post no longer aborts the pass, holds through REV honored (02ff0ccd); failed swap recovery reported as a failed deploy (13eb1daf); Codex children finished and the ledger pruned (2aa2a276); pve trim has its own lock (2eeb340e); Proxmox token fetched once per operation.
- Fleet and root: Logins activity bounded, lock is flock (c6c26a15, b8c2b31d); CT 190 phone alerts go through the Proxmox sender (eac7cbd0); canary cooldown, rate limit and event store (25141eb8); guest power cached, not an SSH every 5 s (a7759962); CT 190 fleet.json carries `proxmoxSsh` (live-checked); finished grant rows expire (ff95e007); one root handler (19837c9c).
- Ops and docs: backup rows stay due while their run goes (3b908e38); `st rollback` previews and needs a single-use confirm (e583a7cf); recovery.md corrected and has the workstation-and-T7-lost path (15587a80); the backup stream that needed SummitFlow's Postgres is gone (4478102e).
- Rex review: fleet link row clears when up (16cde506); stale `tether-link@` unit removed (2358a4d0, 4499b3b4); docs updated (7d842b74); Access token checked at the origin (ee4ecca6); phone gate moved to Aico's data directory (b2d2a14b).
- Coordinator recovery: root's own lane wait kept (e434e4ef); repeat create for a known root no-ops (19837c9c, live-checked in code); late confirm settled once (6b186b12); remote roots rebooked (19837c9c); restore of finished roots resolves (6b186b12); transfer no longer re-sends filed asks, tested through the route (e01f91f8); End-cancels-waits documented in api-v1.md.
- Rex research: waiting sessions push to the phone after two minutes (e01f91f8); guard blocks deleting Aico's backups, secrets and databases, including python/node one-liners (775bfa26); `tether ask create --help` works (19837c9c); terminal compression, alternate-screen seeds and no history resend on resize (c4d03fd5); origin Access check (ee4ecca6).
- Proposal check: Agent Hub units no longer re-enabled and retired units removed (b18b373b, 4499b3b4); CT 190 takes signed updates and follows the workstation's release (f99f2011, 2358a4d0, a9060a6a); Status noise: owner-off rows folded, gone backup sources dropped, revoked grants expire, fleet row clears (abb5c77a, ff95e007, 9aa1fc0f, 16cde506); `nightshift` CLI gone from PATH; broken task importer removed (42f73a9d, 4fab4f08).
- On purpose (2): lab assignment trusts the self-reported work role (by design per the Neri switch note); blocking asks via the Nightshift CLI is moot now that Nightshift is retired.
