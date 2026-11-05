# M10d-1 live verification

The CLI cutover, functional verification and final 30-minute observation passed. The 2026-11-05 06:51:38–07:21:38 UTC scan found zero journal alerts and zero shared-container error lines (`journal-final.json`). All three SF app units remain inactive and disabled; their unit files remain in place.

## Installed runtime

| Component | Source |
| --- | --- |
| ST/Aico command release, service tools | 13b9da207a9898a457b82fb0d820ed1c34c2b0a5 |
| Tether | 66891b6b65aee4171f36b649be6377a7ce932681 |
| Aico web/jobs | b0a450563e7d1386c6d4a91c9ae02d69114d299c; unchanged source inputs in later command releases |
| Agent Hub | 90cb5a28f19ad52b17bc49d9cfd400ef8bf9de9d |
| Proxmox sender follow-up | 72b5d9d31bbd26ead523404381e5478773aabc4a |

All five launcher links (`~/bin/st`, `/usr/local/bin/st`, `~/.local/bin/st`, `~/.local/bin/aico`, `~/bin/aico`) use the committed installed command release. The new CLI has no SF API fallback. `verbs.md` records every former core verb's destination or removal. Unit files and rollback sources remain intact. No Git publication was performed by this lane.

## Checks and review

Before changes, quick passed and isolated acceptance passed for source 982aab14 (146.96 seconds; retained receipt 832e0ac4). Main source checkpoint 272a45e9 passed the scoped 58-stage quick gate. Final full accepted source reports for Aico and Agent Hub are in `final-acceptance.json`. Agent Hub's full acceptance ran its declared migrations and 5,391 Python tests against disposable Postgres, plus 589 frontend tests; no failed acceptance was deployed. All 20 nonexcluded registered projects passed `st check --quick`; see `project-quick-results.json`.

The required independent Codex review and the additional service review are recorded in `review.md`. Concrete findings and live regressions were reproduced before fixes: caller flags/identity, source-root handling, native environments, project-list compatibility, inherited test roles, watcher receipts, Vitest config loading, retained service artifacts and address-specific listener ownership. The final service suite passed 109 tests. The last listener fix also passed actual read-only runtime attestation, while Aico's unrelated LAN phone listener remained untouched.

## Fresh harness and UI proof

Fresh Codex, Pi and Claude Code roots ran pulse, full check, Logins metadata, a scratch mockup addition and an Agent Hub hosts metadata command. Codex and Pi passed after the reproduced inherited-role fixture correction; the final fresh Claude root selected Haiku 5.5/high from the restored launch table and passed. Verification-role Logins lists were empty by policy. `claude-proof.md`, `codex-proof.md` and `pi-proof.md` retain exact results and usability observations. All four owned proof roots were ended.

The rendered mockup page saved a note and selected a mockup. Its exact test question was answered to the creating session and closed; `mockup-answer.txt` records that result. Test questions from the harnesses were withdrawn. One initial proof question reached the real Aico project and was withdrawn by the coordinator; its note now explicitly says the test is complete and no decision is needed. All later proof projects were marked TEST. The browser session was closed; the other M10d lane closed its tunnels and restored VM100's original stopped state.

`mockup-selected.png` shows the selected state. Source and rendered UI lint reported zero mechanical violations; this does not claim visual coverage of every state. The 16 focused mockup behavior tests cover the other implemented states. CLI output now supplies the configured public review-page URL.

## SDK and import

SDK 0.2.1 was installed into the existing standalone environments. Source pins, locks and wheels were then refreshed in Agent Hub, Browser Automation, Code Intelligence, Desktop Automation, Jobinator, Portfolio AI and Vault Tools so rebuilds preserve the migration. Lock audits found no other dependency version changes. `sdk-pins-checkpoints.json` records the six separate tool checkpoints; Agent Hub's pin is in 90cb5a28. Its deployed environment reports SDK 0.2.1 and Agent Hub CLI 0.5.0. Old wheel files remain for rollback.

Agent Hub still has direct prompt writers, so the recurring import was retained. Its old Postgres transport was replaced by an Agent Hub-owned bounded, paged context export using the existing verified service identity. Queries are server-owned and read-only; imported strings stay opaque and database errors omit values. Fixture coverage passed 69 API/CLI/Postgres tests, including exact project-row hashes. The actual scheduler import completed OK: 150 memories and 143 prompts, with matching project records (`scheduled-import-success.json`). Three natural scheduled imports then completed during the clean window; the final run at 2026-11-05T07:20:10.356000+00:00 remained OK (`scheduled-import-final.json`).

## SF and shared infrastructure

SF backend, frontend and Hatchet worker were stopped and disabled around 05:29 UTC and verified inactive by 05:30. Shared Postgres, Redis and Hatchet stayed healthy. The final connection list showed Agent Hub 6, Neri 1 and Hatchet 17 Postgres clients, with no SF client. Redis had no established TCP connection on port 6379 after the SF client exited. Agent Hub backend and its agent/ops Hatchet workers stayed active. The root SF host monitor remains active outside the three-unit shutdown scope and is an M12 review candidate.

Configuration and connection inventory covered workstation units/compose and running CT150/160/170/190. No relevant database use was found in those guests; stopped VMs were not booted for inventory. Neri inspection was limited to unit environment/metadata and database connection metadata. No Neri code, stored data or hunting session was opened. Its environment and SDK pins were not changed; the Neri coordinator's switch instructions are in the M11c handoff.

## Scoped findings and final observation

Cinderwake's non-Aico proof reached its gate but found a missing configured Python 3.12 and a project screenshot assertion. It stayed inactive/disabled and unmodified. Code Intelligence reached isolated acceptance; the environment inference fix restored its Python/type gate, then its tests failed an old X-SummitFlow-Agent-Token expectation. Per coordinator direction that gate-reached proof was accepted and its source tests were left to its owner; only its separately authorized SDK pins changed.

The first journal scan exposed the verbose project-list caller and old import transport; both are fixed. The final scanner reads only the named dependants and shared containers, emits counts/categories/digests rather than application bodies, and excludes Neri and hunting session logs. Its readiness run found zero journal alerts and zero shared-container error lines. The final 30-minute scan also found zero journal alerts and zero shared-container error lines. Current unit/connection checks passed (`final-verification.json`); all three shared containers are healthy. Redis remains running per coordinator direction despite zero live TCP clients; it and the root SF host monitor remain M12 review candidates. Remaining: None within the agreed scope.

## Coordinator follow-up: Proxmox Status relay

After the original clean window, the coordinator found a healthy Proxmox sender briefly marked Late. The 02:30 EST run posted successfully and reached the workstation at 02:33:54; no post was dropped by a 02:25 local redeploy. Both independent timers run every five minutes, but the row deadline covered only one stage plus two minutes of slack. Live reads and a failing regression reproduced the gap. Commit 72b5d9d3 adds an explicit relay budget, passed all 1,219 host tests and 168 contracts, and was installed on Proxmox through its existing installer. A natural workstation heartbeat received the new row with a 12-minute horizon and both host/sender showing OK. See `pve-relay.md` for timestamps, before/after evidence, install hash and scoped rollback.
