Completed: M12-1; sealed archive at `/srv/workspaces/archive/pre-aico/` (2.81 GB, 27,571 files).
Manifest: `manifest.json`; full SHA-256 readback passed; all files/directories read-only and immutable.
Agent Hub: main dump 77.7 MB; separate session-events dump 1.320 GB (3,104,308 rows).
Agent Hub files: 526.1 MB including agents, 1,351 versions, five evaluation READMEs, three workflows and 23,969 context-delivery files.
SummitFlow: 138.2 MB dump, all 39 public tables; named historical tables included.
Monitor: 277.4 MB; design-studio: 436.0 MB (1,394 files); mockup tables included in SummitFlow dump.
Nightshift: 26.45 MB covering three stores, 2,095 receipts, 79 approval files, 32 canary events, ledger and PVE anchors.
Verification: all three dump lists and both full restores passed; retained counts match live snapshots; four SQLite checks passed; 7,043 ledger links match PVE.
Backup: fresh T7 and Drive runs passed under existing workspaces coverage; Aico restored a 404-byte anchor file matching the archive; throwaway container removed.
Pruning: paused through verification, restored exactly as before; Agent Hub kept running; disk stayed 56%, below 85%.
Excluded: credential values/key hashes as approved; schemas and safe host/client metadata retained. Neri content copied opaquely, never inspected.
OmniNull replica stays in place with existing coverage/CT150 backup; regenerable receipts, caches, observations and release builds omitted per cutlist.
Review: one resume defect fixed failing-test-first, independent reviewer cleared it; quick gate passed (1,221 Python tests); source/evidence checkpoint `54ccde69`.
Remaining: None within the agreed scope.
