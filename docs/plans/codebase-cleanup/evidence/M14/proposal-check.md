# Adversarial check of the M13 fix proposal (2026-11-06 ~08:25 local)

Inputs: `evidence/M13/differences.md` + `audit.json` (audited_head d695aea0, observed 2026-11-05 11:39Z), plan.md, cutlist.md, proposal.md.
Commits since 07:30 Nov 5 (11): all Tether recovery, coordinator transfer and prompt-version work. None touches an audit item except the backup-off fix, which landed before the handoff (0eb6f29c, 06:52).
Read-only throughout. I didn't open Neri or hunting data. The publication pre-push hook file was blocked by a guard, so for that one I relied on the audit's evidence.

## 0. Headline corrections (read first)

1. **Agent Hub retirement was undone on 2026-11-05 11:30.** An AH rebuild (`sf-rebuild-agent-hub.service`, journal 11:30:40) re-enabled and started `agent-hub-frontend.service`, `agent-hub-hatchet-ops-worker.service`, `agent-hub-usage-collect.timer`, `codex-session-sync.timer` and `codex-session-close-inactive.timer`. The wants symlinks are dated 2026-11-05 11:30:40-42.
   - Root cause: `/srv/workspaces/projects/agent-hub/project.identity.json` still lists them under `.services.frontend`, `.services.default_workers` and `.services.optional_workers`. Every `st service rebuild agent-hub` turns them back on. AH is still being rebuilt (AH commit 25eab8835 at 11:27).
   - The ops worker then crash-looped about 1,420 times in 12h (Hatchet :7070 is down). It is `failed` now.
   - The codex-session-sync/close timers and AH usage-collect still run every 1-5 min (`systemctl --user list-timers`). The frontend is `active`.
   - The handoff's "AH frontend/workers stopped and disabled" is false today.
2. **A stale `tether-link@.service` crash-looped 5,244 times in 24h** for agent-work and neri-hunters (check-perf: 333/h each).
   - The installed `~/.config/systemd/user/tether-link@.service` is from Oct 30 and runs `tether link %i` with `Restart=on-failure` and `StartLimitIntervalSec=0`. The repo copy (`packages/tether/deploy/tether-link@.service`) is a `/usr/bin/true` stub. The installed one was never refreshed.
   - Someone stopped both loops at 08:11:48 today (`default.target.wants` mtime). Another session is on this: re-check before briefing.
3. **Postgres can't stop with Agent Hub.** `neri-backend` holds its own connections to :5432 (`ss -tnp`: a python pid under `~/.summitflow/services/projects/neri/...`). The proposal's "Neri coordinator, so Agent Hub + Postgres can stop" only covers AH. Postgres retirement needs Neri's backend to move off it, which is the Neri coordinator's call.
4. **CT190 (the always-on peer) is 25 commits behind.** It runs release 223da830 (Nov 5 05:02); the workstation runs 57910f20. Every link-up logs `aico: Tether update failed: No usable signed release; nothing sent` (tether@default journal, 19:47 and 20:49 Nov 5). All failover work depends on fixing this first.
5. **Status headline: "70 problems, 257 healthy" (`st status`). 60 of the 70 are Unknown rows** for portfolio-ai/jobinator jobs on VM 180, which the owner keeps off on purpose. The backup row was fixed; the job rows weren't. The owner sees 70 problems where there are about 10.

## 1. Missed (17)

| Item | Still true? | Call | Challenge / size |
|---|---|---|---|
| Nightly full + live session checks | STILL TRUE: `st check --deep` gives "unsupported --deep"; jobs.json has 12 kinds and no check job. `.git/st/deep-lane.json` last ran 2026-11-04 (SF era). `scripts/live/{live-smoke,tether-lifecycle-harness,tether-real-session-smoke}.sh` exist but nothing runs them. | FIX | S. One jobs.json row runs the full gate plus the three live scripts against tether@dev and writes one Status row with the gate seconds. Either wire the scripts or delete them; orphaned scripts are worst. |
| `st check budget` | STILL TRUE ("unsupported budget") | **DROP, not FIX** | plan.md:153 lists "complexity and size ratchets" under "Skipped as ceremony", and budget is exactly a LOC/test-ratio/gate-time ratchet (plan.md:159). Put the gate time in the nightly row above instead. |
| Dead-code + new-suppression guards | STILL TRUE (no stage in .st-check.toml) | FIX | S-M. The owner asked for exactly these two (plan.md:152). There's no knip, fallow or vulture in node_modules/.bin. fallow 2.57 was run once (evidence/M12-2/fallow-final.json: 246 issues, many false positives such as sw.js and the GNOME extension), so seed a baseline. Group with the nightly job. |
| Peer copy of repos after commit | STILL TRUE (no push/remote code in checks/fleet/tether/ops) | FIX, after the CT190 update fix | S-M. A non-blocking `git push` to peers after `st commit`, plus a bare-repo home on CT190. Pointless while CT190 can't take updates (headline 4). |
| Tasks/questions sync between full peers | STILL TRUE (registry.ts syncs notes.db and web.db only) | **Challenge, lean LEAVE** | Both tasks and asks are made and used by sessions on the same host. When the workstation is off, its asks have no live session to answer them. tasks.db is a separate DB the engine doesn't handle, so this is M, not S. Ask the owner, or drop it. |
| Shared question schema | STILL TRUE as worded | **LEAVE** | `contracts/notice.schema.json:18-20` already has `kind: question` (Needs you via Tether ask). The tray (native/tray/src/notice.rs) and phone (ModelTest.kt:164, phone-api-fixtures) replay the fixtures. A second schema is ceremony. |
| Multi-view hook chain collapse | STILL TRUE: use-terminal-panes.ts 295, use-terminal-tabs-state.ts 233 (its test is 934), slot-handlers 125, project-mode-switch 223 | FIX | L. Two agents (G:e5b6757e: a big-file UI rework needs two). Merge with the cut-short "heavy mock/source tests" item: the named tests are these hook tests. Needs a user-tester pass, since it's the owner's main screen. |
| Memory page | STILL TRUE (no app/memory; /agents = ContextPage with prompts and roles) | FIX, narrowed | S. A memory section inside the existing /agents page: list, search, delete. Read-only otherwise ("rare config gets a read-only view and is changed through agents", plan.md:251). Not a rebuild of AH's 5.6k-line page. |
| Per-session context size | STILL TRUE (inventory.md:127: "Per-root measured context tokens have no Aico equivalent") | FIX, **wrong mechanism in the proposal** | "Hook records delivered bytes" already exists: context.db `deliveries(session, bytes)` (deliver.ts:603). What's missing is the actual context fill. The session readers already parse it per turn (`packages/tether/src/sessions/readers/claude.ts:36-39` input, cacheRead, cacheWrite; codex.ts token_count). Show input+cache of the last assistant turn in root/session metadata. S. Coordinators need it for the ~150K recycle rule. |
| ~13 live tasks | STILL TRUE (6 Aico tasks now, none imported) | Coordinator re-entry: right | The re-runnable importer is **broken**: `st tasks import-summitflow tasks --dry-run` gives "Unknown option '-P'" because it shells out to `st db -P summitflow` (summitflow-import.ts:55), which Aico's `st db` doesn't take. Re-enter by hand from the archive. Also move the on-purpose "one open Nightshift item and 20 docs" item here; it's the same unresolved-carry decision. |
| Repo status rows producer | STILL TRUE (0 `repo` rows) | **Challenge: LEAVE, delete the unused `repo` kind** | Status already has 23 `publish:<repo>` rows (one per repo: ok/failed plus the owning-agent action). The plan said "folded into Status, **or dropped**" (plan.md:285). A second per-repo row family duplicates them. |
| Portfolio backup Failed while VM off | **ALREADY FIXED** in 0eb6f29c (Nov 5 06:52). The row now reads "off: Machine is off; its last good backup date is shown" and check-backups is ok. | Retarget | Same class, not fixed: 60 VM-180 job/service rows count as "Unknown" problems in `st status` (headline 5). S. Rows of an owner-off machine fold into off. |
| OmniNull: signer imports Nightshift | STILL TRUE: `~/.local/lib/nightshift/bin/nightshift-release-signer` runs `from nightshift.signer import main_release_signer`. OmniNull's last commit is Nov 1. | OmniNull lane | M. It's also the last thing that needs `~/.local/lib/nightshift` once the Nightshift remainders are ported. |
| OmniNull push alerts and health | STILL TRUE (0 `ominull.*` rows, hub serves nightshift_feed) | OmniNull lane | M. Hub side. |
| Retired-build checks | STILL TRUE | OmniNull lane | S, hub side. |
| Fleet-protection row | STILL TRUE | Aico side | S, once the hub exposes the enrolled list. |
| OmniNull agent in CT190 | STILL TRUE (`pct exec 190 systemctl list-unit-files 'ominull*'` gives 0) | OmniNull lane | S. |

## 2. Cut short (20)

| Item | Still true? | Call | Challenge / size |
|---|---|---|---|
| Frontend deploy restarts aico-web | STILL TRUE: ops.json:8 `"aico-web.service": ["packages/web-frontend"]` | FIX | S. A frontend-only deploy drops every open session socket. Swap the static dir without the restart. |
| Exact-wording tests | STILL TRUE (mockups/page.test.tsx:48) | **DROP the sweep** | Asserting distinct loading/empty/failed copy is how the "each state gets its own copy" rule gets tested. A repo-wide rewrite is churn. Don't add new ones; trim only within the hook-chain deliverable. |
| Heavy mock/source tests | STILL TRUE | Merge into the hook-chain deliverable | Part of that L item. |
| Full check 145 s vs 105 s | Unverified now. budget.json `gate_median_seconds 145.38` was measured about Nov 4 under SF. | **Measure first** | The nightly row records it. Fix only if a single stage dominates. The commit-time quick lane matters more than the full gate. |
| Job takeover | STILL TRUE (no `workers` on any job) | FIX, narrowed | S. Only `notes-export` (plan.md:134 "from whichever host is up"), maybe `usage-collect`. The backup and publish jobs are hardware/repo-bound. Blocked by the CT190 update failure. |
| Notes own module | STILL TRUE (about 6.7k lines of notes/capture in web-server) | **Challenge: LEAVE** | A move with no owner-visible or speed gain; it doesn't cut LOC. Do it only if notes work starts hurting. |
| AGY Agent Hub dependency | STILL TRUE: agy.ts:264-275 runs `agent-hub/integrations/context-delivery/install.py --check`; delivery.json has only claude-code/codex/pi | FIX, in the AH-off deliverable | S. Give AGY Aico delivery or no shared context. It's one of the things keeping AH alive. |
| Keep import spot check | 22 keep notes present | Coordinator: right | Small. |
| Memory/prompt hash equality | Moot | **DROP** | Live rows have been edited since (prompt revisions, memories 150 to 151). Equality can't hold, and the archive is the reference. |
| Keep-list reconcile | | Coordinator: right | Small. |
| Sudo/asset baseline equality | Moot | **DROP** | The baselines legitimately changed after declared changes (reentries.md:13). |
| 14-host disposition | 4 pinned, 11 revoked | Coordinator: one line | Trivial. |
| Root/CI helper disposition | | Coordinator: one line ("dropped with SF; CI workflows deleted") | Trivial. VM 130 `st-ci-runner` still exists (stopped): note it for its owner. |
| Engine split, fleet out of tether | STILL TRUE: engine.ts 3,343 lines; tether/src/hub 7.4k vs packages/fleet 5.9k | AFTER verdict: fine | L each. |
| Dead-code/duplication one-off runs (`oneoff-reports`) | **AUDIT WRONG** | Close | evidence/M12-2/fallow-final.json, dead-declarations.json and unexported.json exist. All 11 dead declarations are gone from source. The proposal also forgot to list this item. |
| Native contract replay (`contract-native`) | Partly | **LEAVE** | Replay exists in host-steward, pve-sender, hook, tray and android. st-sdk and service-tools don't consume these contracts, so there's nothing to replay. Proposal grouped it as FIX: ceremony. |
| Phone rescue power-off test | | OWNER: right | Ask the owner whether he still wants it, rather than assuming. |
| Neri alerts after first run, VM enrollment | | Neri coordinator / OmniNull lane: right | |

## 3. On purpose (69): items to move out of "leave all"

- **ah-retained / complete-retained → FIX now (S-M).** The consumers that don't need Neri can go today:
  - `/zzupdate` Phase 3 (`agent-skills/commands/zzupdate.md:132-138`) calls `st complete --agent dependency-manager`, which goes to the AH API (`packages/cli/data/extensions/complete.json` owner agent-hub). Have the session do it itself or use a native subagent, then drop the extension.
  - AGY retrieval (above).
  - AH usage-collect timer: duplicates Aico's `usage-collect`.
  - codex-session-sync/close timers: they feed the AH session store, which was retired.
  - AH frontend.
  - Fix `project.identity.json` so rebuilds stop re-enabling them (headline 1).
  - After that, AH backend serves only Neri (lab logins, and the hunting Pi config AH was changed for on 11-05).
- **rendered (session-list check unverified) → do it now.** A one-call `st browser check` or a user-tester run. It's the owner's main screen, and "managed browser failed once" isn't a reason to leave it.
- **reboot-retained / runtime-remainders.** The proposal ports them: agreed, M overall. Two challenges:
  - zswap and summitflow-cpu-epp are kernel/sysfs settings. Do them as config (kernel cmdline or a tmpfiles.d `w /sys/...` line), not a code port.
  - `nightshift-postboot` runs every 15 min (`OnUnitActiveSec=15min`) and re-checks Tether's reboot restore (`tether reboot status`). Check it against the new Tether recovery (6c907958, reboot.ts) before porting; it may be droppable.
  - Port pieces: boot-mark 203 lines, display-guard 169 and input-watch 174 (to host-steward). The signer goes to OmniNull. Then remove `~/.local/lib/nightshift`.
- **sf-publish.** The proposal ports it: agreed, M. The global pre-push hook and `github-delivery` (owner summitflow) still execute SF source.
- **item-doc-carry (1 Nightshift item + 20 docs) → move to the coordinator's re-entry with the 13 tasks.** It's the same "unresolved carry" decision, not a design choice.
- **lab-isolation (fydor-lab-win11, 111) → AUDIT WRONG framing; FIX S.** VM 111 no longer exists (`pvesh get /cluster/resources`: 110, 112, ... and no 111; `qm config 111`: "does not exist"). The permanent check-assets warn comes from a stale asset-registry entry, not an isolation gap. Remove the entry.
- **Rollback leftovers (webpush state, decide DB, ominull cache, comparison table, old DBs).** An owner ask is right for durable data (G:e1f1777c). **But retired unit files are not data.** They're in git and the archive, and keeping them "for rollback" is the grace period G:029fd551 rules out. There are 47 `nightshift-*`/`summitflow-*` system unit files (27 disabled, 16 static, 4 enabled) plus the user units listed in inventory.md:13-85. Their presence is what let headlines 1 and 2 happen. Delete them without an ask, keeping the ones still in use until their port lands, and `nightshift declare` the change.
- **old-receipts (SF `.git/st` 4.6 G, isolated-observations 3.2 G).** It's regenerable, so it can go without an ask. First confirm SF nightly publication doesn't need a receipt for its current main (publish rows gate on "local check at SHA"). Low priority: disk is 57%.
- Everything else in the 69 is fine to leave: owner decisions, old-checkout leftovers covered by the archive, the Python ports, the SSH use.

## 4. Missing from the audit and from the proposal

1. AH units re-enabled by the AH rebuild: the identity file is the root cause (headline 1). **S, urgent.**
2. Stale installed `tether-link@.service` crash loop (headline 2). Remove the template from repo, `scripts/install.sh:164` and host; the daemon owns links now. **S.**
3. CT190 can't receive signed Tether updates and is 25 commits behind (headline 4). **S-M, and a prerequisite for any failover item.**
4. Status noise:
   - 60 owner-off VM-180 rows count as problems (headline 5).
   - `fleet/davion-sidarli` is stuck at "failed: Fleet endpoints must be literal LAN addresses", last updated 2026-11-05 22:21Z (before the 17:30 reboot), while `tether hosts` shows aico connected.
   - 9 backup rows for sources that no longer exist (a-term, tether, agent-hub-telegram-bot-v1, aico-web-state, redis).
   - 15 revoked-grant rows.
   - `jobs/context-unused` warns permanently: "4/90 deliveries fully observed; 83 sessions unavailable". It can't produce a finding; fix the markers or stop calling insufficient data a warn. This is the cutlist 4.2 question.
   - Size: **S together.**
5. The delivered agent context names retired tools. context.db prompts mention `nightshift declare`, `nightshift pending` and `nightshift withdraw` (1 prompt each), `st elevate` (1) and "Agent Hub" (6). Memories mention "Agent Hub" (10), "SummitFlow repair" (1), `nightshift.summitflow.dev` (1), "Nightshift tray" (1) and `st elevate` (2).
   - `host-steward declare` is the live path; `nightshift declare` counts only "until Nightshift stops" (host_steward/declare.py:12-14). Once the Nightshift port lands, agents' declarations silently stop counting.
   - Code comments are stale too (web-server/src/asks.ts:4-6 describes `nightshift pending`; the code uses `pendingGrants`).
   - **S** prompt/memory sweep, using `st prompt measure` before and after. Do it with or after the Nightshift port.
6. The whole `nightshift` CLI (40 subcommands, e.g. `decide`, `ledger`, `drill`, `web`) is still on PATH and callable. It goes with the remainder port.
7. check-sudo warns daily: "summitflow-backup-window 284 vs 15/day". Aico's 5-min `backups-guard` calls `sudo /usr/local/sbin/summitflow-backup-window guard`. Rebaseline it, or have the root guard run under host-steward without sudo-per-call. **S.**
8. `st tasks import-summitflow` is broken (`-P`; see the tasks row). Delete it once the tasks are re-entered.
9. Handoff "known item": `aico sessions list` shows ended pre-M10d lanes as open. Every coordinator reads this list, so it costs daily attention. Close those rows. **S.**

## 5. Suggested deliverables (one agent each unless noted)

| # | Deliverable | Contents | Size |
|---|---|---|---|
| 1 | Retired units stay retired | AH identity-file fix and disable of its frontend/ops worker/usage timer/codex timers; tether-link@ template removal; delete retired nightshift/summitflow unit files (system + user, workstation, gem, CT190) except live remainders; declare | S |
| 2 | Agent Hub down to Neri-only | zzupdate off `st complete`; drop the complete extension; AGY context; confirm AH has no Aico-side caller left. Postgres stays (neri-backend) | S-M |
| 3 | Status honest | owner-off machine rows to off; stale fleet-link row; gone backup sources; revoked grants folded; context-unused semantics; VM 111 asset entry; drop `repo` kind | S |
| 4 | Checks | nightly job: full gate + live scripts, gate time in the row; dead-code + suppression guards with a baseline. No budget command | S-M |
| 5 | Session context size | last-turn usage from the existing readers into root/session metadata | S |
| 6 | Memory on /agents | list, search, delete | S |
| 7 | Frontend deploy without aico-web restart | ops unitSources plus static-dir swap | S |
| 8 | CT190 updates, then failover | fix signed update to the peer; then post-commit peer push and notes-export takeover. Tasks/asks sync: ask the owner or drop | M |
| 9 | Nightshift remainder retirement | boot-mark (+postboot, if not covered by Tether recovery), display-guard and input-watch to host-steward; zswap and EPP as config; prompt/memory sweep (#4.5); remove the nightshift CLI and lib (signer waits on the OmniNull lane) | M |
| 10 | Publication off SF source | pre-push hook plus github-delivery into Aico | M |
| 11 | Hook-chain collapse + hook/source test trim | two agents (hooks; tests and tester pass) | L |
| OmniNull lane | signer, hub push/health, retired-build row, CT190 agent; Aico fleet-protection row after | M-L |
| Coordinator | 13 tasks + Nightshift item/20 docs by hand from the archive; rendered session-list check; keep-import spot check; 14-host and helper one-liners; close stale session rows | S |
| Dropped | budget command, exact-wording sweep, question schema, native replay, notes module move, repo-row producer, hash/baseline equality | - |

Order: 1 and 3 first (they stop live noise and churn), then 2 and 8 (CT190) and 9; the rest in parallel.
