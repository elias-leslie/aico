# M12-1 independent Codex review

Reviewed the archive script/config, brief and cutlist 3.2; no payloads or Neri data opened.
Medium: `scripts/archive-pre-aico.py:139` skips an existing tree during `finish_capture`.
An interrupted `copytree` leaves a partial tree; resuming skips its missing files and sets `finishedAt`.
An isolated temporary fixture reproduced `markedComplete=true` with one source file absent from the archive.
Reconcile missing files while validating existing files, or reject partial trees; add a failing regression first.
The current archive is cleared of this defect by `file-copy-verification.json`, which reports matching source checksums for all four copied trees.

Read metadata only from `/srv/workspaces/archive/pre-aico/verification.json`: both PostgreSQL restores passed, with counts checked by the script against exported source snapshots.
Agent Hub includes 3,104,308 session events; its three credential tables are intentionally empty.
All four SQLite integrity checks passed; the item store contains 32 canary events.
Ledger verification records 7,043 linked entries matching the PVE-confirmed anchor.
Static AST/source-mapping checks and an isolated SQLite WAL-copy check passed in the first review.
Parent checked live foreign-key metadata and found no references to the three omitted-data tables.
Backup restoration and container-removal evidence were outside this narrow follow-up.

Resolved: `copy_tree_once` fills missing files, validates existing files without replacement, and refuses conflicting content.
Both regressions failed before the fix and passed afterward; independent `st check pytest -- native/host-steward/tests/test_archive_pre_aico.py` also passed (2 tests; receipt `.dev-tools/pytest-362668-details.txt`).
`protection.json` records matching SHA-256 readback for all 27,571 files, absent write bits, and immutable files/directories; no unresolved review findings.
