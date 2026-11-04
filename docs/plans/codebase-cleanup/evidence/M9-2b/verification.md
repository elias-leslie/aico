# M9-2b verification

Scope: Portfolio AI and Jobinator on VM 180 use Aico over its private LAN listener, with one token per app. No existing credentials or environment/auth files were inspected or moved. Only newly generated tokens were installed.

## Token and route scope

- The browser/Cloudflare router never mounts the app service router. The app listener binds the workstation's specific private IPv4 address. The firewall permits VM 180's LAN address only.
- Bearer tokens are distinct random 32-byte values; Aico stores only their SHA-256 hashes in its owner-only secrets folder. Each app's owner-only token file and new deployment configuration are outside releases/repositories.
- Each token may ask its assigned model roles, read its assigned Aico prompts, collect public search/page evidence, read/write its own app Status rows on host `apps`, send/resolve its own notices and create/read/close its own asks.
- Tokens cannot run commands, open sessions, access arbitrary files or other app prompts/rows/asks, answer the owner, supply host verdicts or choose Claude. Browser origins and proxy/Cloudflare headers are rejected. Evidence fetching uses the existing public reader, which refuses private and credential-bearing URLs; calls update the webtools usage counter.
- Document images use the Codex route; receipt images retain the local Qwen/Ollama route. Tests cover image preservation, local routing, schema validation and egress refusal.

## Review and reproduced regressions

Independent Codex review: `review-codex.md` in this folder. Coordinator authorized reproductions before fixes and approved the narrow web-evidence endpoint.

- Portfolio `test_vendor_lookup_checks_every_selected_product_beyond_source_batch_cap`: nine selected products reproduced the newly sole fallback path dropping products after four. The helper cap remains; callers now process every batch.
- Portfolio `test_reported_status_keeps_partial_and_failed_results`: three cases reproduced misleading healthy rows for partial, failed and nested-error results; reporting now preserves their severity.
  Red: `.dev-tools/pytest-18e4f96a73f28998-723996-63c64f78-details.txt`; green: `.dev-tools/pytest-18e4f972bfae45a3-725622-0154a9d9-details.txt` in Portfolio.
- Jobinator `test_scheduled_job_report_expires`: reproduced a job report with no next due time. The same schedule data now supplies Hatchet crons and Status due times, with an independent worker heartbeat and initial awaiting-result rows.
  Red: `.dev-tools/pytest-18e4f9682fbb6d53-723350-ce58d59b-details.txt` in Jobinator.
- Jobinator `test_profile_discovery_researches_new_employers_with_an_empty_roster`: reproduced loss of new-employer discovery. It now searches and fetches public evidence through Aico before the model call.
  Red: `.dev-tools/pytest-18e4f98eac583b94-736708-eae70684-details.txt` in Jobinator; both new-employer regressions passed after the fix.
- Aico `withdraws the ask when a condition resolves while its ask is still being created`: reproduced zero withdraw calls after delayed creation. Notify now waits for pending creation before withdrawing and recording recovery.
  Red: `.dev-tools/vitest-18e4f9807394f0d8-732318-95e26695-details.txt`; green: `.dev-tools/vitest-18e4f98f8a76a233-736822-3ed56c5c-details.txt`.
- The real-notifier test also exposed valid notices failing HTTP 422 when a normalized notice was parsed a second time. The route now validates the raw notice and passes the raw object to Notify.

## Checkpoints and runtime proof

- Aico implementation: `7657dcb2f602481b995788de128c379ae4c9f96b`, quick check passed (541 tests, 45 stages).
- Portfolio: `03263585381c2b847c1b9d279e82e48ffba93e6e`. Full gate 3,225 backend and 652 frontend tests; final focused gate 412 passed. All 49 local crons and the independent worker heartbeat are covered.
- Portfolio native release: `20261104T230930Z-03263585381c`. Fresh 283 MB database/uploads backup, import, migration check, backend health, frontend HTTP 200 and all units passed; previous release retained.
- Jobinator backend/worker: `7638c04af4a6e38ae176e1ac01c5bf7cf6329201`. Full gate 962 backend tests and 128 frontend tests. Immutable release at its existing native release root; admitted Python/dependency preparation, runtime-config import, healthy database and backend/worker verified. Existing environment-file paths preserved and previous release/units retained.
- Jobinator UI cleanup: `4fbc45b12f0d76502bda41c5abeb16e4eb763d46`. Removed visible retired Hub links and Nightshift copy, with 72 focused tests/types/lint and uilint passing. Admitted frontend build deployed; settings and usage return HTTP 200 and a served chunk hash matches the new build. Native-library floor GLIBC 2.30 is below guest GLIBC 2.39.
- Jobinator has no app-owned remote release script. Coordinator explicitly approved this one-off native immutable backend/worker deployment and asked that the gap be recorded. No schema or business-data changes were needed.
- Newly generated app tokens/configs stayed outside source/builds. Existing desktop SSH agent supplied the already-enrolled VM login; no keys or other credentials were read/changed. Unused local build copies were removed only after checking symlinks and open files; VM releases remain.
- Shared `main.ts` registration landed with M9-2a in `90170cc5`; both registrations are preserved.
- VM 180 was stopped before this lane, this lane started it, and graceful shutdown after verification completed. `st vm status 180` confirms stopped. Its two app machine rows now explicitly say off. All transient smoke units ended; no owner sessions were used.
- Jobinator live call from VM 180 succeeded through its deployed Aico client: `gemini-3.8-flash`, 11 app Status rows including backend and worker, and test alert `ce976f1c54d6` accepted. Aico journal confirms it arrived via the local service path as an info/tray alert; it asks nobody anything.
- Portfolio live call on the old Hub-default model failed HTTP 502. `agy models` confirmed subscription CLI availability differs from the former API. Regression `routes migrated Portfolio defaults through models the subscription CLI serves` reproduced 502; `2b659ff5e147ef7a5e7ffb3199fee2b5435c481c` moves its chat, equity and list-parser defaults to supported Gemini 3.8. Quick gate passed. The final rebuilt model route passed a real VM 180 retry: Portfolio list-parser returned successfully on Gemini 3.8.
- Aico's first deploy result command incorrectly reported a missing unit/result while the journal later proved the full acceptance (3,291 tests) and successful build/restart/health for `90170cc5`. M9-2a owns the final combined rollout; unit journal and runtime checks are used as evidence, not that premature result line.

## Final coordinator notification change

- Coordinator requested and confirmed explicit optional `actions[].owner_only=true`. `131182c8dee415f3b5b387a1d3793f0fcebad8a5` adds it to the shared schema, TypeScript parser and Python writer helper. Only failed rows naming such an action raise owner asks; ordinary failed rows remain tray alerts. Existing automatic row asks are reconciled and withdrawn at startup.
- Four regressions first failed: ordinary failed row must not ask; only the owner action supplies an ask command; unmarked legacy asks are withdrawn; failed Status alerts use the tray. Red: `.dev-tools/vitest-18e4faf31cd231df-881283-5c0d55be-details.txt` (4 failed, 23 passed). Focused green: `.dev-tools/vitest-18e4fb1686b434b7-895930-cddaae9a-details.txt` (66 passed), followed by startup reconciliation coverage in the final quick gate. Shared native contract check: 124 passed.
- Final quick gate passed 38 stages. Deployment `aico-a42c97093a3f` passed full acceptance with 3,301 tests and deployed `131182c8`; web/jobs units active, `/health` and `/` HTTP 200. This is source/runtime evidence, not the earlier misleading result command.
- The installed host-steward Python helper matched the previous committed version before replacement and now has the new optional action contract. Its check runs load the helper per invocation, so no extra service restart was needed.
- Runtime observation through the public NotifyStore API reported zero linked Status asks after reconciliation. A synthetic ordinary failed row produced critical/tray notice `2e893c6419fa` and no owner ask. The test was recovered and its Status row removed. No live positive owner ask was created.
- Portfolio live proof: `gemini-3.8-flash`, 52 app rows including API/worker, accepted info/tray alert `e2e9e66b64ea`; Jobinator: `gemini-3.8-flash`, 11 rows including API/worker, accepted info/tray alert `ce976f1c54d6`. Aico's journal confirms all three test notices. Test app alerts expired; no test ask remains.
- Remaining: None within the agreed scope. The missing Jobinator release script is a documented deployment gap; the authorized one-off release and rollback copies are complete. Publication was not requested.
