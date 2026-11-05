# Required Codex subagent review

Reviewed the M10c-2b brief, plain recovery scripts, CLI, configuration, append coverage and monthly job. The reviewer made no edits and ran no live backup operations.

| Finding | Failing regression before fix | Resolution |
|---|---|---|
| Early script failures/help do not produce receipt JSON, so blindly parsing stdout loses Status failures | `publishes a failed drill row when the script fails before producing JSON`; help test (`review-regressions-red.txt`) | Validate the receipt; publish a failed row for startup/config failures; help/plan stay read-only. |
| Session counts omit non-ended Aico chats served by `/api/sessions` | `test_counts_include_nonended_aico_chats_served_by_sessions_endpoint` (`review-regressions-red.txt`) | Count retained non-ended chats as well as Tether sessions. |
| A missing `.git` is silently skipped and can pass | `test_drill_requires_the_promised_project_repository` (`cleanup-regressions-red.txt`) | Require the configured repository, verify HEAD and run full Git fsck. |
| A partial sudo copy leaves root-owned scratch directories that ordinary cleanup cannot remove | `test_partial_privileged_copy_is_removed_and_receipted` (`cleanup-regressions-red.txt`) | Check the exact mkdtemp target's device/inode/owner; fall back to sudo removal of only that created target. Record cleanup failure rather than losing the receipt. |
| SIGTERM bypasses ordinary finally cleanup | `test_sigterm_cleans_the_target_and_records_failure` (`cleanup-regressions-red.txt`) | Handle SIGTERM/SIGINT, stop owned child process groups, clean the created target, write a failed receipt and restore signal handlers. |

The reviewer also identified incomplete gem bootstrap coverage. The final plan combines CT 190's own data/Logins/units/config append snapshot with the T7 project repository. `test_gem_bootstrap_combines_own_data_units_and_config_with_backed_up_repo` covers that plan. The gem-gone path in `docs/recovery.md` uses the existing daily Drive CT 190 payload, source/home/root snapshots and guest backups; physical Proxmox/storage/network setup and activation stay manual.

A live dry runtime exposed host paths that were unavailable inside the scratch namespace. The final namespace binds the resolved Node binary, uses a private root and uses the installed Tether bundle when the selective ops release lacks that build. `test_partial_ops_release_uses_the_installed_tether_bundle` was red before its fix (`bundle-regression-red.txt`). The live workstation drill then served matching counts and removed its target.

Source/config/plan tests passed after the fixes: 15 Python tests plus 5 subtests, 7 focused ops tests; full/quick check and isolated acceptance receipts are adjacent. No reviewer finding was left open.

The final ops-only deployment also has no web build. `test_ops_only_release_resolves_the_running_web_code_without_restarting_it` failed before adding read-only unit-path resolution (`web-runtime-red.txt`). The probe now uses the built code of the live web unit, with all restored data still confined to scratch.
