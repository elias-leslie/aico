# Differences from the cleanup plan

Compared with the original plan and cutlist, plus later recorded decisions. Evidence and every baseline row are in [the detailed audit](audit.json). “Unverified” means the result could not be established; it does not mean data was lost.

## Missed

- The plan kept nightly full checks and live session checks; the replacement has no nightly job and rejects deep checks; no reason recorded. [Evidence](../../packages/jobs/data/jobs.json).
- The plan kept check budgets and timing checks; the replacement rejects the budget command; no reason recorded. [Evidence](../../packages/checks/src/cli.ts).
- The plan added dead-code and new-suppression checks after consolidation; neither check is configured; no reason recorded. [Evidence](../../.st-check.toml).
- The plan copied active repositories to peers after each commit; no peer-copy or repository-home mechanism was built; no reason recorded. [Evidence](../../packages/checks/src/commit.ts).
- The plan synced tasks and questions between full peers; notes, view settings and Logins sync, but tasks and questions still belong to one host; no reason recorded. [Evidence](../../packages/web-server/src/sync/registry.ts).
- The plan shared the full question contract across components; notification fixtures exist, but no separate question schema was added; no reason recorded. [Evidence](../../packages/tether/src/asks.ts).
- The plan collapsed the old multi-view hook chain; its session, pane, slot and project-switch helpers still form the same chain; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/audit/aico.md).
- The plan included a memory page; only the store and commands were built; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/cutlist.md).
- The plan kept context measurements; actual per-session context size is now unknown, while the cost page estimates delivered context; the coordinator accepted this gap. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The plan carried roughly thirteen live tasks; none was imported, and the coordinator left their reentry unresolved with the originals archived. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/reentries.md).
- The plan replaced Repo status with Status rows; the row type exists, but no producer or live repository rows exist; no reason recorded. [Evidence](../../packages/status/src/row.ts).
- The agreed Status behavior marks deliberately stopped apps Off; the Portfolio-AI backup still shows Failed while its VM is off, a gap handed to this audit. [Evidence](audit.json).
- The plan moved the release signer to OmniNull before retirement; its installed command still imports Nightshift; no reason recorded. [Evidence](audit.json).
- The plan made OmniNull push alerts and health into Aico; only the receiver was built, the hub still serves the old pull feed, and live health rows are absent; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/cutlist.md).
- The plan moved retired-build checks into OmniNull; no replacement Status producer was found; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/cutlist.md).
- The plan showed fleet machines without OmniNull protection; that Status row was never built; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/cutlist.md).
- The plan installed an OmniNull agent in Aico’s always-on container; no agent is installed there; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/plan.md).

## Cut short or done lazily

- The plan let another machine take scheduled work when its home disappeared; takeover support exists, but every shipped job stays bound to its home; no reason recorded. [Evidence](../../packages/jobs/data/jobs.json).
- The plan gave Notes its own module and database; most notes, capture and sync code still lives in the web server; no reason recorded. [Evidence](../../packages/notes/package.json).
- The plan moved machine placement and links into Fleet; much of that code remains inside the session service; no reason recorded. [Evidence](../../packages/tether/src/hub).
- The plan shipped screen changes without restarting the web server; a frontend deploy still selects and restarts that server; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/briefs/M10c-1.md).
- The plan capped full checks at 105 seconds; the recorded full-check median is about 145 seconds and no final package timings were recorded; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/cutlist.md).
- The plan removed tests tied to exact wording; new screen tests still assert exact loading text; no reason recorded. [Evidence](../../packages/web-frontend/app/mockups/page.test.tsx).
- The plan had every native component replay shared contracts; the gate only checks that some test reads each contract, leaving several native components without replay coverage; no reason recorded. [Evidence](../../scripts/boundaries.mjs).
- The plan proved phone rescue and notes with either host physically down; later evidence shows service/link tests, but no complete power-off journey or BIOS setting proof; no reason recorded. [Evidence](../../docs/plans/notes-and-capture.md).
- The plan verified the Keep import and checked recipes and car notes; 22 imported notes are present, but a completed verification and spot-check record was not found; no reason recorded. [Evidence](../../docs/plans/notes-and-capture.md).
- The plan trimmed heavy mock and source-text tests; some dead tests went, but the named hook tests and source-reading tests remain, with no completed trim recorded; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/audit/aico.md).
- The plan split both large lifecycle files and added direct tests; the host watcher was split, but the session engine is still about 3,343 lines with only narrow engine tests; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/audit/aico.md).
- The plan ran dead-code and duplication tools before pruning; manual audits exist, but no retained tool-run evidence was found; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/audit).
- The plan replaced shared context delivery; AGY still checks the Agent Hub retrieval installer, and its live dependency remains unverified; no narrowing decision recorded. [Evidence](../../packages/context/data/delivery.json).
- The plan accounted for fourteen hosts; only four are pinned now, with no complete disposition for the old registrations, eleven of which were already revoked. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/reentries.md).
- The data plan verified copied memories and prompts by content hash; counts are verified, but the promised equality checks are unverified; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/reentries.md).
- The plan reconciled a project keep list and its history; the registry has current projects, but history and keep-list completeness remain unverified; no reconciliation recorded. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-1/verification.json).
- The plan carried miscellaneous root and CI helpers with their owning modules; the named helpers have no verified port or final disposition; no reason recorded. [Evidence](../../docs/plans/codebase-cleanup/briefs/M7a.md).
- The plan copied the original sudo and asset baselines; presence and schema checks pass, but original equality remains unverified, as the retirement report acknowledged. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/baseline-metadata.json).
- The plan enrolled the two agent VMs with specific protection settings; enrollment and monitor-only settings remain unverified from permitted evidence; no completion record found. [Evidence](../../docs/plans/codebase-cleanup/plan.md).
- The plan checked alerts after the first ordinary hunting run; no completion record was found, and this audit did not open hunting sessions. [Evidence](../../docs/plans/codebase-cleanup/plan.md).

## Done differently on purpose

- The plan put all database access in one store module; 24 direct database imports are still exempted from the boundary check; M0b allowed old exceptions, and these remain. [Evidence](../../packages/web-server/src/notes-db.ts).
- The plan forbade import cycles and cross-layer exceptions; 23 cycle violations and two disallowed package imports remain exempted; M0b allowed old exceptions, and these remain. [Evidence](audit.json).
- The plan required a final rendered session-list check; it remains unverified after the managed browser failed, accepted by the coordinator. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/verification.md).
- The plan used Opus builders and reviewers for key pieces; Codex built and reviewed many after Claude usage ran out, and the promised Opus follow-up is still pending. [Evidence](../../docs/plans/codebase-cleanup/cutlist.md).
- The plan added a separate affected-package script; package dependency lists now select checks directly, removing the redundant script. [Evidence](../../scripts/packages.cjs).
- The plan ran complete test projects for each changed package; related tests replaced that after measurements showed they were faster. [Evidence](../../docs/plans/codebase-cleanup/cutlist.md).
- The plan allowed imports only from lower layers; four explicit same-layer pairs and a lower layer for Usage were chosen for shared behavior. [Evidence](../../packages/usage/package.json).
- The plan kept the agent independent of the session client; it now posts its state and totals through that client so the session service never reads its database. [Evidence](../../docs/plans/codebase-cleanup/cutlist.md).
- The plan limited Python to host checks, the off-host sender and a tiny SDK; service controls and tool admission also remain Python ports. [Evidence](../../docs/plans/codebase-cleanup/evidence/M10d-1/report.md).
- The plan kept a release folder and two links per service; deployments instead share commit-named exports and record previous unit files for rollback. [Evidence](../../packages/ops/src/deploy.ts).
- The early plan added a Wake button and timed a phone wake test; the owner later deferred the button, leaving the existing manual wake command. [Evidence](../../docs/plans/codebase-cleanup/plan.md).
- The early notes design queued offline edits and imported a Drive inbox; the settled design keeps a read-only phone cache and two local stores instead. [Evidence](../../docs/plans/codebase-cleanup/plan.md).
- The vision test planned five samples and a Gemini API run; the owner accepted three photos, and the API run was skipped to avoid sending personal photos there. [Evidence](../../docs/plans/codebase-cleanup/plan.md).
- The notes plan reused the backup login for readable Drive copies; a separate limited Drive login was chosen to keep the backup credential off the other host. [Evidence](../../docs/plans/codebase-cleanup/plan.md).
- The early notes scope included reminders; car reminders moved to Portfolio-AI and generic note reminders were excluded from the first version. [Evidence](../../docs/plans/notes-and-capture.md).
- The early plan listed four Neri entries; they remain unverified here because this effort never opens Neri and its coordinator owns that work. [Evidence](../../docs/plans/codebase-cleanup/briefs/M13.md).
- The plan reserved SSH for manual rescue; guest power checks and backup control still use it, as later briefs allowed. [Evidence](../../docs/plans/codebase-cleanup/briefs/M10c-1.md).
- The early plan deleted the Claude command files; the installed command is gone, but its old files remain in the retired checkout. [Evidence](../../packages/cli/data/cli.json).
- The early plan fixed the old guard fixture; Aico replaced its subprocess replay with an in-process Go corpus instead. [Evidence](../../native/hook/guard/corpus_test.go).
- The early plan deleted the obsolete system-monitor experiment; it remains in the old checkout after runtime consolidation. [Evidence](audit.json).
- The early plan pruned old dead files and mockup ratings; the replacement omits ratings, while old files and empty tables remain archived. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-1/verification.json).
- The early plan squashed SummitFlow migrations; the old migrations remain intact while Aico uses SQLite instead. [Evidence](../../packages/tasks/src/db.ts).
- The plan kept only routed models; the catalog also keeps alias targets so model restrictions can recognize them. [Evidence](../../packages/context/data/models.json).
- The plan retired Agent Hub and PostgreSQL; both still run for the unconfirmed Neri switch, older sessions and retained commands, as the coordinator required. [Evidence](../../docs/plans/codebase-cleanup/briefs/M12-2.md).
- The plan removed the completion gateway and command; both remain because the update skill still calls its dependency-manager agent. [Evidence](../../packages/agent/package.json).
- The plan estimated fifteen roles; the chosen set is twelve job policies and five named roles, following the curated keep list. [Evidence](../../packages/context/data/agent-hub-import.json).
- The plan had a provider sign-in card and secret files; the owner replaced them with a shared Logins store, page and machine sync. [Evidence](../../docs/plans/codebase-cleanup/briefs/M11c-logins.md).
- The plan entered four context budgets by hand; a one-time script copied them instead, using an import guard to preserve later edits. [Evidence](../../packages/context/src/import.ts).
- The data table started usage history fresh; useful daily history was carried and hash-checked instead, following the earlier accounting row. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/reentries.md).
- The plan had the owner reenter secrets; the owner later authorized a direct migration into Logins, preserving the originals. [Evidence](../../docs/plans/codebase-cleanup/briefs/M11c-logins.md).
- The plan handed the new login and SDK calls to the Neri coordinator; a switch note exists, but delivery and completion remain unverified because no coordinator was available. [Evidence](../../docs/plans/codebase-cleanup/evidence/M11c/neri-switch.md).
- The early plan deleted the Claude worker files; they remain in the old checkout, while their runtimes were retired under the later rebuild decision. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The early plan pruned unreachable context-editor files; the whole old frontend was disabled and replaced instead. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The early plan deduplicated old Codex protocol files; the old checkout retains them as reference, with no Aico client dependency. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The early plan moved audits and evaluations out of the main checkout; they remain there, with selected evaluation files also archived under the later consolidation. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The early plan squashed Agent Hub migrations; they remain intact while SQLite replaces their use in Aico and legacy callers retain PostgreSQL. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The early plan removed dead modules and backfill scripts individually; those files remain in the old checkout after runtime retirement. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The early plan trimmed Agent Hub mock-heavy tests; Aico rebuilt tests around new modules instead of pruning the old suite. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The plan dropped the old cleanup system; only package-cache cleanup was restored, leaving scratch, model and project-artifact retention deferred by the coordinator. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/coordinator-followup.md).
- The plan moved publication into Aico; scheduling moved, but Git delivery and the outgoing verifier still run from SummitFlow source, as the coordinator retained them. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/coordinator-followup.md).
- The plan rebuilt tool manifests and reports; manifests and managed runs stayed, while adoption, audit and cost reports were dropped with their old telemetry. [Evidence](../../docs/plans/codebase-cleanup/evidence/M10d-1/verbs.md).
- The plan optionally copied nine recent mockups; they remain in the archive, and the coordinator accepted leaving that optional copy undone. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/reentries.md).
- The plan cleared regenerable check state; SummitFlow still holds about 3.2 GB of isolated observations, with replacement aging deferred by the coordinator. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/coordinator-followup.md).
- The plan started operational history fresh; selected host metrics were carried so trend checks could work immediately after cutover. [Evidence](../../native/host-steward/host_steward/checks/__init__.py).
- The plan moved reboot and postboot checks into Aico; Nightshift still supplies boot markers and the postboot timer under a coordinator-approved deferral. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The plan ported telemetry; run and step measurements stayed, while the incident table and retired-board readers were deliberately omitted. [Evidence](../../native/host-steward/host_steward/telemetry.py).
- The plan ported the independent push alarm; sending moved to the Proxmox sender so it works when the workstation is down. [Evidence](../../docs/plans/codebase-cleanup/evidence/M5b-1/replacements.md).
- The plan ported the purple-team drill; the later brief narrowed it to grants and a synthetic canary, omitting real decoys, listener detection and item-store restore. [Evidence](../../docs/plans/codebase-cleanup/briefs/M5b-2.md).
- The plan kept canary callbacks; they are LAN-only because the owner rejected public callbacks, and the bypass draft was never applied. [Evidence](../../packages/web-server/src/canary.ts).
- The plan carried one open Nightshift item and twenty documents; reentry has not been demonstrated, and the coordinator preserved the originals instead of guessing. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/reentries.md).
- The plan re-paired the phone; the app kept its existing identity and pairing for an in-place update, avoiding an unnecessary owner step. [Evidence](../../docs/plans/codebase-cleanup/briefs/M4b.md).
- The plan deleted empty Web Push state; Web Push stopped, but the old state file remains with coordinator-preserved rollback data. [Evidence](../../docs/plans/codebase-cleanup/evidence/M5b-1/replacements.md).
- The plan rebuilt standalone notice pages; notices and actions now use Status, Needs you, the tray and phone, following the settled screen design. [Evidence](../../docs/plans/codebase-cleanup/plan.md).
- The plan exposed host commands through Aico; they remain a separate host-steward command selected by the port briefs, with no recorded reason for the changed spelling. [Evidence](../../docs/plans/codebase-cleanup/briefs/M5a-1.md).
- The plan deleted the old comparison table; its timer stopped, but the table remains in preserved source data and the archive for rollback. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The plan deleted the old decision database after archiving; the runtime stopped, but its original database remains under the coordinator’s preservation decision. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-1/verification.json).
- The plan dropped the GNOME tray extension once desktop-bridge covered it; that replacement is incomplete, so the port deliberately kept the extension and icon. [Evidence](../../docs/plans/codebase-cleanup/plan.md).
- The plan moved passkey enrollment into tray storage; enrollment remains in the root grant store, following the later root-verifier design. [Evidence](../../native/host-steward/host_steward/data/grants.toml).
- The plan retired legacy host helpers; display and input handling, zswap and CPU setup still use the old services under coordinator-approved deferrals. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The broad plan kept phone approval; the more specific tray-only design lets the phone view and revoke grants, while approval requires the desktop security key. [Evidence](../../packages/web-frontend/app/grants/page.tsx).
- The early plan sped up Nightshift’s existing suite; new native tests replaced that suite under consolidation instead. [Evidence](../../.st-check.toml).
- The early plan merged old decision modules and feed versions; the settled cutlist dropped those runtimes and rebuilt deterministic rules instead. [Evidence](audit.json).
- The early plan kept the ledger and monthly drill; the settled plan archived the ledger and made the smaller drill run on demand. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-1/verification.json).
- The plan deleted the old OmniNull cache; it remains with preserved rollback state after retirement. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/inventory.md).
- The plan proved service controls on another project; Cinderwake stopped at existing Python and screenshot-test failures, accepted by the coordinator as that project’s follow-up. [Evidence](../../docs/plans/codebase-cleanup/evidence/M10d-1/live.md).
- The plan proved the Code Intelligence integration; its existing token-header test still fails, so the coordinator accepted only proof that the gate ran. [Evidence](../../docs/plans/codebase-cleanup/evidence/M10d-1/live.md).
- The plan ported pressure reclamation; the old automatic snapshot-prune command was removed with no configured replacement, under the bounded cleanup decision. [Evidence](../../docs/plans/codebase-cleanup/evidence/M12-2/coordinator-followup.md).
- The plan ported push-path testing; the old drill that stopped delivery services was omitted in favor of a bounded off-host alarm proof. [Evidence](../../docs/plans/codebase-cleanup/evidence/M5b-1/replacements.md).
- The asset check was ported, but fydor-lab-win11 still warns that isolation lacks network-card evidence; that existing lab finding was left outside cleanup fixes. [Evidence](../../native/host-steward/host_steward/checks/registry.py).
