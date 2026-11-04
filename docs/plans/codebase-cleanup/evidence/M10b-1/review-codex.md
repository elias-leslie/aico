M10b-1 review and follow-up, 2026-11-04 (Codex)

Findings were sent to coordinator 125cc8cd before their fixes; checkpoints 748affdf and 7decb2eb contain the first fixes.
- Native `biome check .` ignored the changed-file scope after formatting: scope both full and quick Biome stages, including `.mjs` files.
- Concurrent shell snapshots lost the owner of new files: record literal redirections, honor `exec_command` workdir, retain known writers; indirect/unleased concurrent writes remain unknown.
- Long commit subjects split mid-sentence: preserve the whole subject and trailers.
- JUnit regex accepted comments as tests and mishandled CDATA, attributes and malformed XML: use the pinned saxes XML parser; restore JSON evidence count validation too.
- Scoped pass reuse missed dirty dependencies, and native stage receipts ignored their scoped command: bind both inputs and planned commands.
- Files could change after checking while commit waited for its lock: recheck content and coordination inside the lock.
- CLI commit split quoted paths containing spaces: preserve argument boundaries.
- Explicit formatter directories/environment overrides bypassed writer checks: always exclude known other writers; allow unknown writers only when their files are named individually.
- Native checks had lost shared resource admission: the coordinator approved the launcher bridge through public `st tools run` (help stays immediate).
Verification: initial 15 tests passed; regression probes failed before fixes; final checks suite 23 passed; quick gate 13.6 s (8 stages); managed Go vet/test passed (3.2 s); shell syntax and diff checks passed.
Runtime: installed only committed hook source; two fresh shell identities ran overlapping writes through the installed hook and actual `aico check --fix --changed-only`: own file formatted, other file unchanged, native Biome scoped, pass in 0.2 s. This was a synthetic integration probe, not model-driven user testing.
Unrelated ops and coordinator guard work was preserved; no publication, credentials or Neri data were involved. CLI rollback remains `ST_AICO_CHECKS=0`; hook rollback is its previous release link.
