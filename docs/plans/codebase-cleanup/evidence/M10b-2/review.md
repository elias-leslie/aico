Required Codex review (read-only) found four reproduced issues: selected-commit proof could include dirty unselected dependencies (both Aico and SF writers); owner policy wrote SF instead of Aico; global -P was lost; nightly text output expected legacy row fields.

Each issue received a failing regression before its fix. Codex re-review confirmed all four resolved: Aico publication tests 9 passed; SF seam tests 9 passed. Subsequent relevant-package check: 176 passed.

Additional reproduced issue fixed before source checkpoint: an empty quick check on a clean checkout must not authorize a prior unchecked commit. The commit's scoped quick gate and an exact committed-tree acceptance still record their own proof.

The required reviewer also caught that the local PostgreSQL fixture still activated only when a workflow existed. A regression without ci.yml failed before activation was corrected. Follow-up tests reproduced and fixed relative tool seeding, verdict-name parsing, failed acceptance overwriting a previous pass, and clean legacy full-gate bookkeeping. The final shared-HEAD acceptance then exposed a registry-order assumption after the parallel Logins entry; its test now selects the Aico namespace regardless of order (same-seed focused suite: 10 passed).
