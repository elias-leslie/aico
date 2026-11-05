M11c Logins is complete and deployed on both full peers. No real secret value was printed, logged or captured.
Commits: 82e7664e, 0958b947, 25bdcd1e, b85e1a08, ed5bda90, 2e035372, e40e970b, 9a6875be, 39913f44; ST binding b0d19484 (SummitFlow).
Own source/test checkpoints: +4654 / −268 LOC; evidence is in this folder.
Store: 38 entries; names only in store-names.json and store-check-final.json (same set on both full peers).
Added backup-append.ed25519/password, restic-local.password, restic-drive.password, summitflow-drive.conf, pve-append.ed25519, pve-backup.ed25519; originals preserved.
Imported 22 live Agent Hub rows; six expired rows skipped; source rows preserved. Existing lab files remain indexed. Two app entries hold verifiers only on VM180; release signer stays local outside Logins.
CLI: aico/st/tether logins list/show, hidden/stdin set/rotate, scoped run, private-file get, grants, owner-confirmed remove, coordinator assignments and lab refs/enroll/refresh/patch/fd run.
Page: /logins, grouped list/search, write-only add/replace, timed reveal/copy, grants, confirmed remove, lab edits/assignments, merged tool sign-in.
Live: shell scratch set/use and output refusal; page add/replace/copy/reveal/grant/remove; backup-password reveal succeeded without displaying its value.
Worker: exact granted subset; synthetic assigned hunter enrollment/refresh/patch/refs/fd run passed; other target, backup/raw-tool use and Claude refused; permitted Pi runtime passed. All scratch files/assignments removed; agent-work off; neri-hunters untouched/off.
Design: 1600×900 and 390×844 screenshots inspected; source uilint 5 checks/187 files and both rendered 6-check runs passed with zero violations (mechanical only).
Tests: required Codex review fixed; red/green regressions; quick gates passed; full committed acceptance before/after; full-peer list/event recursion red/green; final gate receipt in acceptance-final.txt.
Deployment: accepted 39913f44 on both full peers; 55 session-list reads per host kept control sockets 2→2→2, and bidirectional Logins sync still passed afterward (federation-live.json).
Neri switch: old/new contracts in neri-switch.md for coordinator relay; no Neri code/data/session opened. Agent Hub originals retained pending its switch.
Remaining: None within the agreed scope.
