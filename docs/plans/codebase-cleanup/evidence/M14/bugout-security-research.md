# Bugout and Security Research: keep, consolidate or archive

Reviewed 2026-11-06, approximately 10:20–10:30 America/New_York. Brief: [bugout-security-research-review-2026-11-06.md](/srv/workspaces/projects/aico/docs/plans/codebase-cleanup/briefs/bugout-security-research-review-2026-11-06.md).

## Recommendation

| Project | Decision | Reason |
| --- | --- | --- |
| Bugout | **Keep, with a narrower and accurately documented operator role.** | It owns executable lab fixtures, bounded recon, capture workbench code and the installed guest reaper. Neri's current product does not replace these lab recipes or their recovery role. Moving the repository now breaks a registered CLI and the reaper's working directory. |
| Security Research | **Consolidate the useful operating guidance and experiment conclusions, then archive the repository intact.** | It is a conversational entry point plus completed synthetic experiments, with no observed application runtime or external code caller. Its durable domain owners already exist elsewhere. Preserve the experiment history and negative results instead of promoting unused model or review code into a running product. |

Neither archive nor consolidation was performed. The only intended repository change from this review is this report and its scoped checkpoint. No code, configuration, project registration, unit, VM or hunting state was changed.

## Scope and confidence

I read Bugout and Security Research documentation and selected source, project registration and project-scoped operating memory; Neri's README, product design, proxy README and selected source; Aico's README, CLI registry/routing and VM implementation; Browser Automation's collaboration plan; and Ominull's README and selected code-path searches. Runtime checks were limited to local unit metadata, the Bugout reaper's own service journal, listener/process metadata and read-only CLI prerequisite/status queries.

**No file inside Neri Hunters was opened.** Its top-level directory was listed once to identify the repository boundary. I did not descend into it, search its contents, inspect its Git history/status, query case records, or read hunting sessions or session histories. No Neri database or proxy case store was opened. Bugout's retained research-reference and artifact contents were also left unread. Credentials were neither requested nor printed.

This establishes local registrations, source dependencies and the observed reaper failure. It does not establish which labs are currently in use, whether an owner still prefers the Security Research conversational entry point, or whether an unreviewed private workflow references either path. Those questions were deliberately not answered through hunter data. Experiment results below are retained project results, not newly reproduced measurements. No experiment, inference, browser session, recon operation or test suite was run.

Snapshot: Bugout HEAD `bc3d84233bd83ee843b7913c03d2eec96fe27027` (2026-11-01); Security Research HEAD `8aa62b4defb237c737349b4df0dd0360cf7c7fbe` (2026-10-15). Both working trees were clean during inspection.

## Bugout

### Purpose today

Bugout is an operator repository for authorized program-specific lab work. It contains reproducible range fixtures and runbooks, a deterministic recon runner, a disposable mitmproxy capture workbench, a bounded revocation operator and guest-cleanup automation. Its Python project has no production dependencies declared and is not an application server. The main README distinguishes operator material from durable research records and restricted originals. [README](/srv/workspaces/projects/bugout/README.md:1), [pyproject.toml](/srv/workspaces/projects/bugout/pyproject.toml:1).

The README's description of Neri as a text-only case repository is stale. The current Neri README assigns structured program/case state and the owner page to Neri, and narrative/evidence files to Neri Hunters. Use that current ownership when updating Bugout's documentation. [Neri README](/srv/workspaces/projects/neri/README.md:1).

### Live pieces, callers and retained data

| Piece | Observed status and callers | Retention/dependency implication |
| --- | --- | --- |
| `bugout-lab-guest-reaper.timer` and `.service` | User timer enabled, active/waiting. Last trigger 10:20:02 EST; next 11:20 EST. Service exited 0 at 10:20:02. Installed under `~/.config/systemd/user/`. | Hourly dependency on the exact checkout path. **A successful service exit currently conceals failed housekeeping**, detailed below. |
| `operators/recon/` | Aico's live extension catalog reports `bugout.recon` prerequisites present. Binding uses `execution_source: checkout` and `operators/recon/bugout`; passive `st bugout recon --help` works. | An installed, callable tool, not proof of recent target use. Immutable plans, SQLite journals and a local outbox are its state contract; no journals were opened. |
| Obsolete deployment observer | The live catalog still registers `bugout.deployment`, but reports its `operators/recon/observe_deployment` executable missing. | Existing stale registration, not another working Bugout service. Source history records the observer/Neri sink removal on 2026-10-27. |
| `range/`, `range/workbench/`, `operators/matomo_revocation/` | Source and dedicated tests exist. Workbench docs describe disposable guest deployment, actor/run attribution and selected proof contracts. No persistent host application process was identified. | These are operator-invoked assets; their existence is not evidence of an active lab. Guest copies and private captures are separate retention boundaries. |
| `config/lab-guests.json` | Names four lab VMs, baselines/recipes, a 24-hour TTL and storage threshold. | Required by the reaper; VM120 is explicitly excluded from automatic reset. |
| `references/`, `artifacts/`, `evaluations/` | Retained directories exist; 28 tracked paths across these three roots. Contents were not opened. | Preserve their provenance and the repository history. Do not infer that everything named “artifact” is expendable. Private originals belong outside this checkout according to its README. |

The working tree contains about 2.7 MB of regular-file content excluding Git, tool history, virtual environments and caches. Size is not a reason to absorb this repository into a live product. `st projects show bugout` reports an active registration with no `data_dir`; its default 3000/8000 ports are not evidence of a server. `st service status bugout` returns “Registered project bugout has an invalid runtime identity,” and no app listener was observed on those default ports. Only the reaper units were found in the reviewed installed unit definitions referencing Bugout.

The actual extension registrations now live in [Aico's registry](/srv/workspaces/projects/aico/packages/cli/data/extensions.json:27). SummitFlow retains matching registry source, but the current `st` executable routes through Aico. Do not repair only the old SummitFlow copy. [Aico extension resolution](/srv/workspaces/projects/aico/packages/cli/src/extensions.ts:177).

### What the reaper protects—and its current failure

The timer runs at minute 20 each hour, with `Persistent=true` and one-minute accuracy. The service runs `/usr/bin/python3 -m operators.lab_guests` from `/srv/workspaces/projects/bugout`. Installed unit contents match the checked-in unit definitions. [Service](/srv/workspaces/projects/bugout/operators/lab_guests/systemd/bugout-lab-guest-reaper.service:1), [timer](/srv/workspaces/projects/bugout/operators/lab_guests/systemd/bugout-lab-guest-reaper.timer:1).

Its intended protection is disposable-lab hygiene: return eligible guests to known clean snapshots, leave them stopped, and report storage pressure at 85% of `local-lvm`. That can remove stale lab execution and reclaim changed guest state through rollback; it is not a backup, evidence-retention system or storage garbage collector. The configured guests are:

| VM | Baseline | Automatic reset |
| --- | --- | --- |
| 120 | `clean-neri-lab` | **Disabled** with `auto_reset: false`; inventory/report only. |
| 121 | `clean-neri-gitlab` | Eligible under the code's guards. |
| 123 | `clean-neri-wordpress-core` | Eligible under the code's guards. |
| 124 | `clean-woocommerce-multisite` | Eligible under the code's guards. |

The guard requires an enabled guest with a configured recipe and clean snapshot, matching VM name, the snapshot present in inventory, acceptable state, no VM lock and no explicit `held_vms` entry. A stopped guest not started since its last rollback stays clean. Successful reset must return the expected identity/snapshot and stopped state. `held_vms` is currently empty. [Config](/srv/workspaces/projects/bugout/config/lab-guests.json:1), [decision code](/srv/workspaces/projects/bugout/operators/lab_guests/reaper.py:138), [reset verification](/srv/workspaces/projects/bugout/operators/lab_guests/reaper.py:123).

**“Idle” means age since the last `qmstart` in this implementation.** The code does not measure recent interaction or query a reservation/active-hunt ledger. A running guest older than 24 hours can be selected unless explicitly held. The range README's claims about reservation release and “unreserved and idle” do not describe this implementation, and its Neri-owned reaper/config references are stale. Preserve VM120's exclusion and reconcile active work/holds before any future repair is exercised. No active hunting state was inspected for this review. [Decision code](/srv/workspaces/projects/bugout/operators/lab_guests/reaper.py:155), [stale range instructions](/srv/workspaces/projects/bugout/range/README.md:13).

**Observed failure:** the reaper's own journal records `Lab guest probe failed: Managed VM command unavailable` at 09:20:00 and 10:20:02 EST on 2026-11-06. Both reviewed runs produced no successful reset record. `observe()` calls `st vm observe ... --storage ...`; `reset()` calls `st vm reset ... --name ... --snapshot ...`. The current CLI advertises list/status/ip/start/shutdown/stop/snapshot, and Aico's VM implementation has no corresponding observe/reset operations. This is consistent with interface drift at the Aico boundary; remote guest state and credentials were not probed. [VM calls](/srv/workspaces/projects/bugout/operators/lab_guests/reaper.py:79), [Aico VM operations](/srv/workspaces/projects/aico/packages/ops/src/vm.ts:113).

The failure is swallowed into a warning report. Normal mode returns 0 even when inventory is unavailable, explaining systemd's `Result=success`. `--preflight` instead has a failure exit path, but was not run. The timer is live; its cleanup protection is currently unproven and failed in the observed runs. [Failure handling](/srv/workspaces/projects/bugout/operators/lab_guests/reaper.py:204), [CLI exit behavior](/srv/workspaces/projects/bugout/operators/lab_guests/reaper.py:268).

### Overlap

| Other owner | Overlap | Recommended boundary |
| --- | --- | --- |
| Neri | Authorized research, evidence identities, and now an intercepting proxy/sandbox. Bugout workbench also uses mitmproxy and capture/proof records. | Neri owns its current policy-enforcing proxy and product state. Bugout retains isolated fixtures, reproductions and operator-specific capture contracts. These proxy paths have different contracts; avoid keeping two defaults for live hunting. |
| Neri Hunters | Program-related work is adjacent to Bugout fixtures/references. | Neri's README describes Hunters as the narrative/evidence repository. Keep executable fixtures and lab recovery in Bugout. No assessment of duplicated case material was made. |
| Aico / former SummitFlow tooling | VM operations, CLI extension dispatch, sessions and generic lifecycle. | Aico owns the shared VM transport/CLI; Bugout owns guest-selection policy, snapshots/recipes, recon semantics and tests. The broken VM contract should be repaired at this existing boundary. |
| Browser Automation | Browser collaboration, input ownership and viewing support the workbench. | Generic browser behavior stays there; capture lanes, fixtures and program-specific material stay in Bugout. This split is already documented in the local-browser guide. |
| Ominull (brief spelling: OmniNull) | Both observe network activity; Ominull also contains endpoints. | Ominull owns endpoint/router flow telemetry and response controls. HTTP authorization-sequence fixtures, recon and Proxmox lab cleanup are different responsibilities. No direct dependency was found in the reviewed code paths. |

Sources: [Neri proxy README](/srv/workspaces/projects/neri/proxy/README.md:1), [Bugout local-browser boundary](/srv/workspaces/projects/bugout/range/workbench/LOCAL-BROWSER.md:13), [recon contract](/srv/workspaces/projects/bugout/operators/recon/README.md:1), [Ominull README](/srv/workspaces/projects/ominull/README.md:1).

### Recommended disposition and archive consequences

Keep `range/`, `operators/`, `config/`, their tests and the fixture/reference history together. Do not move them into Neri Hunters, the Neri backend or Ominull merely to reduce the repository count. Bugout was already separated from the former Neri corpus; its README preserves the source commit and historical manifest identities.

Recommended follow-up changes, **not performed here**:

1. Repair the scoped inventory/reset contract in Aico's `packages/ops/src/vm.ts` and CLI routing, or adapt Bugout to an equivalent supported scoped API. Keep selection/hold policy in `bugout/operators/lab_guests/reaper.py` and `config/lab-guests.json`. Verify read-only inventory first; evaluate the hold/TTL semantics before enabling effective resets. Surface failed inventory as a detectable health failure.
2. Remove the obsolete `bugout.deployment` binding from `aico/packages/cli/data/extensions.json` and its bundled `extensions/bugout-observer.json` manifest after checking its remaining source references. Retain `bugout.recon`.
3. Update Bugout `README.md` and `range/README.md` to the current Neri/Neri Hunters ownership and actual reaper guards. If the current Neri proxy replaces a workbench route, retire that route only after its required capture/proof contract has an identified replacement; do not implement a general proxy merger now.

If Bugout is simply moved to `/srv/workspaces/archive/bugout-2026-11-06/`:

- The installed service's `WorkingDirectory` becomes invalid. Leaving its timer installed creates recurring service failures; removing/moving the units removes the intended cleanup and storage-warning schedule. Existing failure does not make losing the responsibility harmless.
- `st bugout recon` loses its registered checkout executable. Passive bundled help can still appear, so help alone would mask the break.
- Recipe, verifier, operator and runbook paths used by humans or private workflows stop resolving. Reprovisioning or recovering a guest loses its current source location. Guest copies may continue to run; moving the repo does not shut down or clean lab VMs or export their evidence.
- The public Neri application has no direct import/path dependency on Bugout in the reviewed source. Its structured state and narrative evidence would not be deleted by a move, but that does not certify every lab workflow as independent.

Archiving Bugout would therefore require a real transfer or deliberate retirement of its operator and cleanup responsibilities, plus CLI/unit/registration changes. That work has not been justified by this review.

## Security Research

### Purpose today

The declared product is a persistent conversational workspace: route learning to Learn-o-Tron, authorized investigations to Neri, implementation gaps to the tooling owner, and continuity/policies to Aico context. It explicitly assigns session-specific records to other systems. Its actual repository also retains three substantial synthetic traffic experiments and a Learn-o-Tron walkthrough preview. [README](/srv/workspaces/projects/security-research/README.md:1), [ownership](/srv/workspaces/projects/security-research/CONTEXT.md:15).

### Live pieces, callers and retained data

| Piece | Observed state | Implication |
| --- | --- | --- |
| Workspace identity and policies | Active Aico project registration; three project-scoped memory records describing native-TUI use, tool choice and research economics. | Useful entry point/continuity, but not a distinct execution or storage subsystem. Transfer the needed routing before retiring it. |
| Server/units/database | README declares none. `backend/` has no tracked files; installed unit searches found no Security Research unit. No local listener on registered 8018 or generated 3000/8000 defaults. No managed release beyond an empty deployment lock directory. | No observed runtime to preserve or stop. `st service status` refuses the project's runtime identity. |
| Registered URLs | Registry still advertises local port 8018 and `security-research.summitflow.dev`; `.index.yaml` advertises generic 3000/8000 defaults. | Stale or unsupported runtime metadata, not evidence of a live application. Public URL/tunnel/DNS was not tested. |
| `experiments/traffic-review-v1/` | Deterministic synthetic HTTP-sequence classifier, schemas, abstention rules, offline loopback HAR adapter, review UI, fixtures, focused tests and retained synthetic review records. | Reusable research assets, not a production capture/finding service. The adapter does not capture traffic itself and is not qualified for arbitrary target traffic. |
| `experiments/local-traffic-classification-v1/` | Completed 96-row synthetic holdout: learned/retrieval methods did not justify advancement. | Preserve the negative result, blind-custody commits, receipts and source together. No model promotion is justified by this record. |
| `experiments/local-traffic-classification-v2/` | Stopped in label-free Phase A: warm p95 104.109 ms versus a 50 ms gate; no scored classifier result. Owner review says stop without unchanged retries. | Completed feasibility stop, not a running model service. The retained 2026-10-15 post-run check reported no model resident then; this review did not check current model residency. |
| `docs/collaborative-hunting-plan.md` and walkthrough preview | Plan records synthetic collaboration completion and first authorized target selection as a later stage. HTML labels itself a proposed Learn-o-Tron walkthrough. | Preserve reusable conclusions; do not treat a plan or preview as a deployed workflow. |

There are 186 tracked experiment files. The tree contains about 17.5 MB of regular-file content excluding Git, tool histories and caches. No external code caller of these experiment directories or the repository's absolute path was found in the reviewed Aico, SummitFlow, Neri, Browser Automation and Ominull code roots. Neri does reference the shared **skill** `security-research-writing`; that is a skill dependency, not a dependency on this repository. [Neri skill names](/srv/workspaces/projects/neri/proxy/neri_proxy/hunt_shared.py:10).

The focused results come from [traffic-review README](/srv/workspaces/projects/security-research/experiments/traffic-review-v1/README.md:1), [v1 result](/srv/workspaces/projects/security-research/experiments/local-traffic-classification-v1/BLIND-RESULT.md:1), [v2 owner review](/srv/workspaces/projects/security-research/experiments/local-traffic-classification-v2/PHASE-A-OWNER-REVIEW.md:8) and [completed-plan status](/srv/workspaces/projects/security-research/docs/collaborative-hunting-plan.md:3).

### Overlap

| Other owner | Overlap | Recommended boundary |
| --- | --- | --- |
| Neri | Investigation workflow, review discipline, traffic inspection and agent collaboration. | Neri already owns case/program state and a current intercepting proxy. Consolidate concise reusable operating conclusions into its docs; preserve experiments as historical evidence, without adding a classifier subsystem. |
| Neri Hunters | Research narratives/methods are conceptually adjacent. | Keep case-specific state where Neri documents it. This archive recommendation needs no access to or migration of Hunters data. Do not copy target-independent experiment bundles into case folders. |
| Aico | Stable project identity, prompts, memory, native-session continuity and implementation coordination. | Aico supplies these shared capabilities already. Transfer the small set of still-applicable workspace instructions rather than retaining a separate repo for routing alone. |
| Bugout | Capture review, fixture operation and collaborative browser workflows. | Bugout owns executable program/lab operations. The synthetic traffic classifier is not an installed Bugout dependency; import code later only for a demonstrated operator need. |
| Ominull | Traffic classification and evidence labels. | Endpoint/router flow telemetry is not synthetic HTTP access-transition classification. No operational integration was found; no code transfer recommended. |
| Browser Automation / learning owner | Generic watch/control/pointing; training conversation and walkthrough UI. | Generic browser implementation already belongs in Browser Automation. Learn-o-Tron is named by old docs, but `st projects show learn-o-tron` currently reports no project; do not assume a live migration destination for the preview. |

### Exact consolidation and archive plan

The target paths below are **proposed**, not existing transfers or edits. They deliberately move a small amount of current guidance; the original experiment tree stays intact in the archive.

| Source | Exact target and treatment |
| --- | --- |
| `README.md`, `CONTEXT.md`, current Aico `security-research` project memory | Consolidate still-applicable investigation routing, native-TUI preference, tool-selection discipline and separate outcome/payment facts into Aico context under project scope `neri`. Reuse existing canonical policies/skills; add only missing instructions. Add a short pointer from `neri/README.md` to the retained research notes. Preserve the original files in the archive. |
| `docs/collaborative-hunting-plan.md` | Extract completed collaboration lessons and remaining applicability limits into proposed `neri/docs/research/collaborative-hunting.md`. Link current Browser Automation and Neri proxy contracts. Treat the October plan as historical; reconcile its now-stale assertion that Neri has no proxy and its old model/workflow assumptions. Preserve the full plan at `archive/security-research-2026-11-06/docs/collaborative-hunting-plan.md`. |
| `experiments/traffic-review-v1/` | Preserve whole directory at `archive/security-research-2026-11-06/experiments/traffic-review-v1/`. In proposed `neri/docs/research/traffic-review-results.md`, retain a brief reuse index and its synthetic/loopback-only boundary. Do not install the classifier, adapter or UI into a live route. |
| `experiments/local-traffic-classification-v1/` and `...-v2/` | Preserve both as siblings under the same archived repository, including tracked receipts, cached artifacts, tests, reviews, and the full `.git` history. In `neri/docs/research/traffic-review-results.md`, record v1's no-advancement verdict and v2's label-free stop with source links. No model/runtime code migration. |
| `path-traversal-walkthrough-preview.html` | Retain at the same relative path in the archive. No current consumer was found, and no active Learn-o-Tron project was found; no speculative UI migration. |
| Project identity, registry and obsolete runtime metadata | After guidance is transferred and links checked, retire `security-research` in Aico with the archive path/reason, preserving its history. Reconcile its old URL/port metadata and entry-point links. This review did not change them or inspect session histories. |

Here `archive/` means the brief's `/srv/workspaces/archive/`. Move the complete repository to `/srv/workspaces/archive/security-research-2026-11-06/`, including `.git` and retained files, rather than cherry-picking experiment sources into another history. V2 imports V1 by sibling path and checks canonical Git metadata at a hard-coded original root; V1's custody checks depend on the original commit sequence. Moving the repo preserves records but does **not** make historical runners automatically executable at the archive path. A future rerun requires a deliberate path/custody review and, where required, a fresh preregistration. [Sibling import](/srv/workspaces/projects/security-research/experiments/local-traffic-classification-v2/semantic.py:11), [canonical-root constraint](/srv/workspaces/projects/security-research/experiments/local-traffic-classification-v2/phases.py:20), [Git custody](/srv/workspaces/projects/security-research/experiments/local-traffic-classification-v1/custody.py:18).

Expected loss from retirement is the separate conversational project entry point and old path links, plus direct execution assumptions in the historical runners. No reviewed production caller would lose a required runtime library. Preserve Aico's historical records and shared skills in their owning stores; moving this repository neither migrates nor deletes them. Hand off this review's current workspace before any later relocation.

## Decision order for the coordinator

1. Keep Bugout registered and in place. Record the reaper as an observed cleanup failure and the deployment observer as a stale extension; assign follow-up work separately.
2. Transfer only Security Research's current guidance and concise research conclusions to the named destinations; verify pointers and retain the complete experiment/Git record.
3. Then archive Security Research and retire its entry point through the normal owner-approved cleanup procedure. There are no observed Security Research units to move. Do not archive Bugout as part of that step.

Remaining uncertainty is owner preference for the separate learning workspace and private path usage. Neither uncertainty requires opening Neri Hunters data. If that separate workspace is still intentionally used, keeping only its identity/routing docs is a reasonable temporary alternative; the completed experiments can still remain historical rather than becoming a new product.

## Verification record

- Read-only Git status/log checks for Bugout and Security Research; both clean at inspection.
- `st projects show bugout`, `st projects show security-research`, scoped `st memory list`; no case or session-history queries.
- `systemctl --user show` with the user's existing bus selected, installed unit-file reads and unit-definition path searches. No start/stop/reload/reset command.
- Reaper-only `journalctl --user -u bugout-lab-guest-reaper.service` for 2026-11-06 since 09:00, summarized by known warning/reset markers and warning timestamps.
- `st tools extensions --check`, with output restricted to the reviewed owners; `st bugout recon --help`; `st vm --help`; `st service status` for the two reviewed projects.
- File metadata/counts, bounded source searches excluding case/hunt/session/evidence/report data roots, listener checks for 8018/8000/3000 and process names/CWDs only. Observed processes were review/tooling shells and this agent's helpers, not an identified project app server.
- No tests, inference, target operations, live hunter inspection, archive actions or service changes. Report verification/checkpoint and coordinator handoff are the brief's explicit deliverable exception to the otherwise read-only review.
