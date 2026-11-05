Completed M10b-2: Aico schedules checked-main publication; ST/SF delegate; commits and done stay local.
Aico: e2fd3030 source; b1d46038 backup job-list handoff checkpoint (backup implementation belongs to M10c-2).
SummitFlow: e5194d96, d9821834, 86a65a53, 137c4529, a6509ea6, 12610222, 4e9c85d2, 569dc865, a13875de, 0c006eb7.
Agent Hub: 4a37b355, cd4a8146, c2e01408, 4907c765.
Agent Skills: 31d4a336, d6d2e783; Blackbox: 519ce38b.
Browser Automation: 98a93607; Code Intelligence: f8c4f57a.
Desktop Automation: 54de7595, 3241d306, 9ca5ea8b.
Jobinator: 420aa22d; Portfolio AI: 420b81b4, d6b6a46c, 15fe9f12.
Uilint: a68f1d99; Vault Tools: 5253be61. Full OIDs and subjects are in commits.json.
Deleted and published 15 workflows: Aico ci/release, SF ci/docker-build/docker-integration, ten other repeat-local ci files.
Kept: Ominull Windows/mixed-native suites and manual profiler, SHA macOS, tag/manual image/artifact publishers and private adapter integration; six unregistered CI files unchanged by coordinator direction. No CodeQL workflow was present; Actions gates/waits are gone from the active publication path.
Live: first scheduler pass made 3 pushes; final pass made 2. GitHub main SHA/workflow-path inspection is in remote-proof.json; SF nightly switch is false.
Guards: deliberate unchecked Agent Skills commit refused with Status, then cleared after checking; failed checks name their stages. CLI transport worked with SF DB unreachable; outgoing-history secret and workflow-effects guards remain.
Tests: quick gates passed; full before/after Aico and SF acceptance passed (Aico 3310 Vitest + 1153 Python; final SF 6180 Python + 391 frontend). Required Codex findings were reproduced and fixed; evidence records the follow-up regressions.
Runtime: Aico e2fd3030 deployed and served /health and /; final SF 0c006eb7 deployment 482f58fc60e346bf8483ba7a134526ef succeeded. Retained SF transport is CLI-only, with no DB/service dependency.
Rollback: ST_AICO_PUBLISH=0, stop Aico github-publish job, restore current owner policies through SF controls and reenable its existing nightly switch; details in rollback.md.
Deferred by coordinator: Blackbox browser-e2e/go-tests/osv/webcrypto fixes. Ominull unchecked main remains its owning agent's Status item; final scheduler correctly reports these two refusals.
Remaining: None within the agreed scope.
