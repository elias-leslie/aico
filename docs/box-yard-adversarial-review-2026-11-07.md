# Box Yard comparison: adversarial review (2026-11-07)

Reviews `docs/box-yard-comparison-2026-11-07.md` against Aico's code at 20eb0520 and box-yard 3ed69f4 (shallow clone, read only, never run, deleted after). Every item is judged on merit only: value to a solo owner whose agents do the work, tokens/compute, build effort, upkeep, ceremony, performance, and overlap with what Aico already has. Repo age, stars and authorship are not used as arguments.

## Two facts the first comparison got wrong

1. **Aico already has a headless chat runtime.** `packages/agent` (about 7k lines) runs the Aico agent: a chat per run with a queue for messages sent mid-turn, Stop, Resume with another model (`packages/agent/src/chats.ts:330-380`), Branch from a reply (`chats.ts:294`), a `swapped` state when the provider served another model (`chats.ts:535`, `outcomes.ts:64`), Pi compaction (`compaction.ts`) and a model chain that skips used-up subscriptions (`packages/agent/src/rules.ts:57-76,299`). The web app has a chat view for it (`packages/web-frontend/components/chat/ChatSession.tsx`). The doc framed Aico as terminal-only and Box Yard's headless-turn model as the alternative; Aico already runs both.
2. **Usage already counts per project, per message.** `packages/usage/src/claude-transcripts.ts` (header, lines 1-11) and `codex.ts` keep requests and tokens per day, model, **project** and speed, counting each message once by message id. Box Yard's "charge the step from the previous total" rule exists because it reads `claude -p`'s cumulative `total_cost_usd` (README "Usage and costs"); Aico never reads cumulative totals, so it has no double counting to fix.

## 1. Verdicts

### The five recommendations

| Item | Doc said | Verdict | Cost and upkeep | Why |
|---|---|---|---|---|
| 1. Continue with another harness, bounded recap | Adopt (medium) | **Adopt smaller** | Small: one CLI flag plus one button. Each use costs a recap of a few thousand tokens. Little upkeep, since it reuses the existing transcript readers | For Aico agent chats this already exists (model chain plus Resume with another model). The gap is only Claude Code / Codex / Pi terminal sessions. Box Yard's version (`docs/task-continuation.md`) carries pins, transactional queues and archive-restore refusal, which are needed because it owns task workspaces; Aico sessions work in the real checkout, so none of that applies. Smallest version: `st aico create --continue-from <session> --tool <codex|claude|pi>` builds the brief from the session's first prompt, its last few assistant replies (`packages/tether/src/sessions/readers/{claude,codex,pi}.ts`) and `git status --short` of its cwd, then launches through the normal create path. Put one "Continue in…" action on the used-up notice. Coordinators can already do this by hand, so the value is mostly in sessions the owner started himself |
| 2. Per-session hidden WIP ref shipped to the peer | Adopt (medium) | **Adopt smaller, only as part of the failover item** | Per-session idle-edge hook: medium build, permanent upkeep (ref cleanup, restore path). Smaller job: small | Losing local work is already covered: Btrfs snapshots of `/srv/workspaces` every 30 minutes, kept 6h recent / 24h hourly / 3 days daily, plus native captures every 4 hours (`packages/ops/data/backups.json` `schedule.snapshotMinutes`, `retention.snapshot`, `nativeSources`). Uncommitted files are inside those snapshots, and agents commit routinely through `st commit`. The only real gap is a copy on the peer host when the workstation is down, which is the ROADMAP "Failover" item. For that, one job (in `packages/jobs`) is enough: every N minutes, for repos changed since the last run, push branches plus a `git stash create` commit to a bare mirror on the peer under `refs/aico/wip/<host>`. That means one ref per repo and no per-session state, hook or cleanup lifecycle |
| 3. Redact known secret values in transcripts | Adopt (small) | **Adopt a different small version** | About 15 lines; no upkeep | Value-based redaction means the web server reads every login value, but `packages/web-server/src/logins.ts:167-170` reads values through an audited `client.value(name, owner, 'reveal')`. Redacting each render would flood that audit or need a bypass, which weakens the logins design. Applying the current `maskSecrets` to transcripts is also wrong: its long-run rule masks any all-hex 32+ character run (`packages/shared/src/secrets.ts:31-46`), so every git SHA and sha256 in an agent transcript would turn into "hidden". Smallest useful version: export the high-precision subset (`KNOWN_TOKENS`, `PRIVATE_KEY`, `BEARER`) and apply it to Recent/History transcript text. Value is low to medium: the owner is the only viewer, but tester screenshots end up in `evidence/` |
| 4. Spend by project and role, counted as steps | Adopt (small-medium) | **Drop the step rule; adopt a tiny display change** | Display only: small | Project attribution already exists in `usage.db` (above). The step rule fixes a problem Aico doesn't have. On subscriptions, dollar figures are notional; what matters is each project's share of a window, which the existing rows already give. Smallest version: a by-project split on the Quota page and in `aico usage show`, from the existing `daily` rows. Role would need a session-to-role join that transcripts don't carry, so skip it until someone asks "which role burns my quota". Keep #24 (spend per day per provider) as planned |
| 5. Scripted fake agent for tests | Adopt (medium) | **Drop; optional replay driver later** | Box Yard's fakes total about 1.6k lines (`scripts/fake-claude.mjs` 980, `fake-codex.mjs` 306, `fake-cursor.mjs` 298), maintained against every CLI change | Box Yard's fakes work because Box Yard owns the protocol it calls (`-p --output-format stream-json`). Tether instead reads what the real CLIs write to disk and to the pane. A hand-written imitation of those formats keeps passing after the real CLI changes, which is exactly the class of bug it was meant to catch. Aico already tests against recorded real material: `packages/tether/src/test-fixtures/model-switch/*.jsonl` (including a real incident), pane captures `claude-rewind-*.txt`, and live smokes (`scripts/live/tether-real-session-smoke.sh`, `scripts/live/live-smoke.sh`). If session-state bugs keep coming back, build a small driver that appends a recorded transcript into a temp session folder on a timer, which is replay, not imitation |

### Every "ours" / "mix" row in the table

| Item | Doc said | Verdict | Cost and upkeep | Why |
|---|---|---|---|---|
| Agent runtime | Ours | **Keep ours; the reason needs correcting** | None | Aico already has a headless runtime as well (`packages/agent`). Box Yard has a real advantage the doc skipped: a headless turn holds no memory between messages, while an idle Claude Code TUI does (one observed here at 615 MB RSS after 25h). That would matter for unattended lanes under Aico's memory-pressure admission. But most delegated work now runs as native subagents (owner rule G:e5b6757e), and lanes are coordinators and hunters that benefit from being interactive. Revisit only if admission starts refusing launches because of idle TUIs |
| Surviving restarts | Ours | **Agree** | None | Box Yard's Coordinator and Captain turns are lost on restart (README line 232). Tether's generation fencing and announced recovery cover coordinators too (`packages/tether/docs/crash-recovery.md`) |
| How coordination works | Ours | **Agree** | None | No orchestrator process to keep alive. See "state up front" in the missed table below |
| Task model | Ours, "keep only-owner-marks-done in mind" | **Agree; drop the note** | None | Having only the owner mark work done gives the owner a chore per task, which is the admin he doesn't want. The Finished group already rests sessions without it |
| Where work runs | Ours | **Agree** | None | Own hardware, no cloud keys or spend |
| Isolation | Ours | **Agree** | None | Same trust model (Box Yard's local and SSH tasks are unsandboxed too) |
| Admission and cleanup | Ours plus one idea | **Agree; drop the idea** | None | The "never delete a folder in use or holding unpushed work" rule protects per-task folders. Aico has none: agents work in the real checkout. Nothing to apply it to |
| Protecting work in progress | Mix | **See #2** | | |
| Switching harness | Theirs | **See #1** (smaller, terminal sessions only) | | |
| Model routing | Ours | **Agree** | None | DB rows fed by live quota beat free-text YAML the model must interpret |
| Subscription limits | Ours | **Agree** | None | Login round robin only matters with several subscriptions of one provider |
| Spend tracking | Mix | **See #4** (step rule dropped); also agree with skipping the budget gate | | |
| Owner alerts | Ours | **Agree** | None | FCM-only is the owner's rule (G:1c1c6f8e) |
| Asking the owner | Ours | **Agree** | None | |
| Remote access and auth | Ours | **Agree** | None | Cloudflare Access plus an origin re-check. The password stack (`server/password.ts`, a 20.9k-line `commonPasswords.ts`, `loginLimit.ts`) solves a problem Aico doesn't have |
| Secrets in transcripts | Mix | **See #3** (different small version) | | |
| Identities | Ours | **Agree** | None | One account |
| Git and pull requests | Ours | **Agree** | None | Direct to main |
| Scheduling | Ours | **Agree** | None | See "quiet no-op runs" below if scheduled agent runs start |
| Event hooks | Ours (for now) | **Agree** | None | Lane reports cover it at this scale |
| Agent-to-agent messages | Ours | **Agree; skip the FYI flag** | None | Lane reports already back off with floors and doubling quiet periods (`packages/tether/src/lane-reports.ts`) |
| Project memory | Ours | **Agree** | None | |
| Context and compaction | Ours | **Agree** | None | The Aico agent uses Pi's compaction. Terminal coordinators hand off fresh by owner rule |
| UI model | Ours, borrow reading | **Agree; build it in what exists** | Small | Improve `components/history/HistoryTranscript.tsx` and reuse `chat/MessageText.tsx`. Don't add a third transcript renderer |
| State storage and code shape | Ours | **Agree** | None | A design argument (`server/tasks.ts` 9.3k lines, `store.ts` 4.5k, `mcp.ts` 3.5k), not about age |
| Testing | Mix | **See #5** (drop) | | |
| Tool-state backup | Ours | **Agree** | None | |
| Maturity | Ours | **Remove the row** | | Not a merit argument (owner instruction). No Box Yard feature I would adopt is shown broken in its code. The one thing marked unfinished is sub-tasks: `server/subtasks.ts:1` says "prototype" |

## 2. What I would actually build, in order of value per effort

1. **Activity line in the session list** (small). Under each working session, show what it is doing now ("Editing web/src/App.tsx", "Running st check"), taken from the last tool call the readers in `packages/tether/src/sessions/readers/` already parse. Box Yard: `shared/activity.ts`. Aico's list shows state but not activity, and this is the glance the owner makes most often from the phone. Not in the first comparison.
2. **Continue in another tool** (#1, smaller version): one flag on `st aico create`, plus one button on the used-up notice.
3. **Search in History** (small to medium). A text box on `components/history/HistoryPage.tsx` that Tether answers by scanning transcript text it already reads; scope by project and tool as today. Box Yard: `server/history.ts` (also a scan, not an index). Answers "which session did X" without asking an agent to grep `~/.claude/projects`. Not in the first comparison.
4. **Project split on the Quota page** (#4, display only).
5. **High-precision secret masking in transcripts** (#3, the ~15-line version).
6. **Peer WIP push job**, built only as the first step of the Failover roadmap item (#2, one job, one ref per repo).

Dropped: the fake agent, the step-cost rule, value-based redaction, per-session idle-edge WIP refs.

## 3. Missed by the first comparison (full sweep)

I listed every top-level directory, all 19 `docs/*.md`, the 4 `docs/perf/*.md`, the README in full, `AGENTS.md`, the header of every `server/*.ts` (94 files) and `runner/*.mjs`, every `scripts/*` file, every `web/src/components` and `web/src/lib` name (opening the headers of the ones that looked like features), and all `test/` file names. Rows below are features the first comparison didn't cover or only mentioned in passing.

| Box Yard feature (path) | Aico equivalent | Verdict | Cost and upkeep / why |
|---|---|---|---|
| "What it's doing" line per task (`shared/activity.ts`, `web/src/lib/taskSummary.ts`) | None in the session list (`components/SessionList.tsx`); `tether sessions` shows only last-activity time (`sessions/cli.ts:89`) | **Adopt** (shortlist #1) | Small; reuses parsed transcripts |
| Keyword search over past chats, compactions and tasks (`server/history.ts`) | History filters only by tool, project and session (`web-server/src/history.ts:79-83`) | **Adopt smaller** (shortlist #3) | Small to medium; a scan, no index |
| State up front: tasks a message names are injected with their current state, saving a ~2.7s tool step (`server/handoff.ts`) | Lane reports carry state; coordinators call `st aico` for the rest | **Drop** | In a Claude Code coordinator it would need a per-prompt hook that adds tokens to every turn, for about one saved tool call |
| Captain's read-only repo clone, answering code questions without a task (`server/captainRepo.ts`) | Coordinators work in the real checkout | **Drop** | Doesn't apply |
| Side threads: highlight a passage and ask in a forked session (`server/sideThreads.ts`) | Aico agent: Branch from a reply (`agent/src/chats.ts:294`) | **Covered** | |
| Notes retro: agents suggest, the Captain accepts, merges or rejects at task end, under a budget (`server/retro.ts`, `notes.ts`) | Scoped, budgeted memory with save rules (`packages/context`) | **Covered** | An automatic retro per task would add a model turn per task |
| Notice batching, quiet agent wakes, Coordinator auto-turn cap (`server/noticeBatch.ts`, `orchestrator.ts`, README "Quiet agent wakes") | Lane-report floors and doubling quiet periods | **Covered** | |
| Quiet no-op runs: a scheduled run that found nothing is hidden from Recent and alerts (`shared/quiet.ts`) | Jobs run commands; no scheduled agent sessions today | **Drop for now** | Adopt (one outcome flag) only if scheduled agent sessions start flooding Finished |
| Recommended next steps as tap chips (`shared/nextSteps.ts`, `RecommendedNextSteps.tsx`) | `tether ask` options | **Drop** | Rewards agents for stopping to offer next steps, which the owner's rules forbid ("never hand doable work back as next steps") |
| Queued messages with Cancel/Undo, Stop, Steer (`web/src/lib/takeBack.ts`, `QueuedMessages.tsx`) | Aico agent queue (`chats.ts:341-348`); terminal CLIs queue typed input themselves | **Covered** | |
| Up/Down prompt history per chat (`web/src/lib/promptHistory.ts`) | Terminal CLIs have their own | **Drop** | Low value |
| Command palette with ranking (`CommandPalette.tsx`, `docs/perf/command-palette.md`) | `SessionSwitcher.tsx` | **Covered** | |
| Per-turn timing chip and stage breakdown (`server/turnTimings.ts`, `TurnTimingChip.tsx`); turn trigger recorded (`turnTrigger.ts`) | None | **Drop** | Tunes a loop Box Yard owns; Aico doesn't own Claude Code's loop |
| Coordinator compaction history files and lookup tools (`server/compactions.ts`, `compactionTasks.ts`) | Memory, plan docs, fresh handoffs | **Drop** | Covered by owner rules |
| Sub-tasks via `spawn_subtasks` (`server/subtasks.ts`, marked prototype) | Lane helpers with parent lineage (`lane-reports.ts`) | **Covered** | |
| `create_tasks`: up to 100 tasks with a shared brief, all-or-none validation (`server/mcp.ts`) | Workflow agents (ultracode), `st aico create` | **Covered** | |
| `related_tasks` passing earlier outcomes to a new task | Briefs | **Covered** | |
| Priority queue for slots (`shared/priority.ts`) | Pressure admission, no queue | **Drop** | |
| Interrupted turn retried up to 2x with "you were interrupted"; missing session starts fresh from a recap (README 226-227) | Announced crash recovery (`tether/docs/crash-recovery.md`) | **Covered** | The recap builder would be shared with #1 |
| Retry one size up after an OOM kill; auto-sizing from measured peaks (`server/turnPeaks.ts`, README 225) | Per-pane MemoryMax, OOM policy, admission (`doctor.ts:122`, `agent-admission.ts`) | **Covered** | |
| Setup card that checks CLIs are installed and signed in (`server/localCheck.ts`, `setup.ts`) | `tether doctor`, sign-in links (`lifecycle/tui/sign-in-link.ts`) | **Covered** | |
| Model list read from the CLI; smoke test of every picker model (`server/claudeModels.ts`, `scripts/smoke-models.ts`) | Catalog in context.db, `lifecycle/tui/models.ts` | **Drop** | Spends a turn per model; worth it only if the catalog drifts from the CLIs |
| Sleep/wake detection (`server/sleep.ts`) | Workstation doesn't sleep | **Drop** | |
| Per-task folders, dependency hard-link cache, build-output and low-disk cleanup (`server/janitor.ts`, `ownCleanup.ts`, README 198-216) | Agents work in the real checkout | **Drop** | No per-task folders to manage |
| Live PR state on resume, merge follow-up that closes issues (`server/prs.ts`, `mergeFollowUp.ts`) | Direct to main | **Drop** | |
| Published artifacts and preview URLs (`server/artifacts.ts`, `report_preview`) | `tether share`, Files, `st browser preview` | **Covered** | |
| Attachments, thumbnails, image sizes (`server/uploads.ts`, `thumbs.ts`, `imageSize.ts`) | Capture and attachments (`components/capture`, `chat/ChatAttachments.tsx`) | **Covered** | |
| Dictation, TTS (`useDictation.ts`, `server/tts.ts`) | Phone keyboard dictation | **Drop** | Voice not wanted |
| Test tiers, machine-wide test lock, `test:related` (`scripts/testTiers.ts`, `testLock.ts`, `test-related.ts`) | `st check --changed-only`, managed admission | **Covered** | |
| Web performance suite: ~55 scripts, a heavy seeded dataset, a bundle-split test (`scripts/perf/*`, `server/mockHeavy.ts`, `test/bundle-split.test.ts`, `docs/perf/*`) | None found for the web app | **Adopt smaller, only on a reported problem** | If phone jank on long sessions comes up: one seeded heavy session plus one render timing in the existing user-tester flow. No standing suite |
| Kept chats left mounted but hidden for instant switching (`web/src/lib/keptChats.ts`) | None | **Drop unless switching is slow** | |
| One server per data folder (`server/dataLock.ts`) | Tether generation fencing | **Covered** | |
| Terminal client for a running yard (`scripts/yardctl.ts`) | `st` and `tether` CLIs | **Covered** | |
| Usage audit from a copied DB (`scripts/usage-audit.mjs`) | Not needed (no cumulative totals) | **Drop** | |
| One-way-out rule for Back/Close/Esc (`docs/dismiss.md`) | `ui-spec.json` and uilint | **Optional** | Copy the rule into `ui-spec.json` only if testers trip on it |
| Login round robin, per-project identities, connectors, cloud providers, status-only projects, branch-name conventions, box history, daily cloud limit, Codex auth refresh, GitHub reference picker, onboarding prompts (`docs/logins.md`, `identities.md`, `connectors.md`, `server/providers/*`, `branchNames.ts`, `boxHistory.ts`, `cloudLimit.ts`, `credentials.ts`, `githubReferences.ts`, `TryFirst.tsx`) | n/a | **Drop** | No multi-account, PR, rented-compute or onboarding need |

**Sweep complete.** I didn't open in full: the provider docs (`daytona.md`, `docker.md`, `runpod.md`, `vast.md`, `cursor.md`, `codex.md`, `machines.md`, `identities.md`, `connectors.md`; headings only, all about compute, accounts or connectors Aico has no use for), the bodies of `server/tasks.ts`, `store.ts`, `mcp.ts` and `runner/box-runner.mjs` (judged from headers and README), the `web/` component bodies beyond headers, and the individual `test/*.test.ts` files (names only). Nothing was run.

## 4. What matters more than any of this for getting the most from agent partners

- **Make it cheap for the owner to see what agents are doing without opening each one.** The activity line and History search both serve the owner's actual job (direct and review), more than any back-end feature here.
- **Idle terminal sessions cost memory, and Aico has no idea that headless turns would save it.** If lanes multiply, measure idle TUI memory against admission refusals before building anything. Running unattended lanes through `packages/agent` (already headless) may be the cheap answer.
- **Test against real material, not imitations.** Aico's lead over Box Yard here is recorded real transcripts and live smokes. Keep growing that fixture folder from each real incident instead of writing fakes.
