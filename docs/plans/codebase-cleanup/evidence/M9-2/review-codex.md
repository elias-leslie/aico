# M9-2a Codex review

Required independent Codex review completed 2026-11-04, read-only.
Seven supported findings reproduced and fixed: compaction losing use markers; old replies crediting new deliveries; no post-delivery reply counted as complete; old item versions still alerting; named roles becoming launch jobs; failed marker writes counted as complete; chosen Codex instructions lost for a blank-slate role.
The coordinator validated the first two reproductions and authorized reproducing/fixing further concrete findings. Each has regression coverage; SQLite write failure is injected after the reviewer reproduced actual database contention.
The reviewer independently verified 57 focused tests and synthetic ended-session binding and chosen-instruction preservation.
Reviewer test output: `.dev-tools/vitest-18e4f9e34b69ff02-760965-b4c79819-details.txt`.
Parent focused run: 68 passed, `.dev-tools/vitest-18e4f9e04624a0bd-759900-678730e2-details.txt`.
No remaining supported correctness findings. Live deployment, rendered views and scratch-session proof are recorded separately.
