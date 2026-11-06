# Post-consolidation recommendations (2026-11-06)

From four Haiku 5.5 user testers (desktop web, phone, sessions, CLI) and one Opus 5.5 user review.
Evidence: evidence/user-test-2026-11-06/{web,phone,sessions,cli,opus}/. Key claims re-checked live by the coordinator.
Effort: S small, M medium, L large (agent time). Nothing changes until the owner approves.

## A. Wrong or misleading (fix first)
1. Session state tells the truth: Recent shows the running coordinator as "Finished"; Projects shows "2 jobs failed" while Status says 0 failed; smoke-test and tmp runs and junk test projects (aico-m10d2-live, m10b-live-*, commit-try) clutter Recent and filters. One source of live/finished state; badges match Status. (M)
2. Honest failed states: home and the session view sit on grey skeletons for 20 s+ when the server is down; Backups shows "Failed to fetch". Copy Status's failed state ("Can't reach Aico since 4:23 PM · Retry", last known data marked stale). (S)
3. Needs you card: render markdown (shows **Pace hunting:**), plain meta ("No rush · asked 48 min ago" instead of "whenever · 48m"), "Not now" styled apart from "Open session", full-height note box, open in the main pane on desktop, fix the wrong tab highlight. (S)
4. Note previews mask secret-looking strings (a Telegram bot token shows in a preview today; rotating it is your call). "New note" saves only once something is typed. (S)
5. Usage wording: "Used up. 5h 100% left" contradicts itself; say which window is used up and when it resets. (S)
6. Roadmap: commit trailers ("Co-Authored-By…") show as changelog items; "plan" link only copies a path, so open the plan in Aico (works on phone); Now/Next labels instead of dot style; empty state for projects without a roadmap; label the power icons. (S-M)

## B. Finding your way
7. Home becomes a triage view: Needs you (count + first ask), Working, Idle/stuck ("idle 40 min"), Finished since you last looked, the worst Status problem, a quota line. About 5 main nav items, the rest under More. (M)
8. Phone parity: bottom tab bar (Sessions, Needs you, Status, Projects, More). Projects, Backups, Grants, Logins and Phone app are unreachable on the phone today. (S)
9. One name per concept: this machine is "This computer", "Workstation" and "davion-sidarli" (and a host is called "aico"); a session is "Aico" on the web and "Session 36" in the CLI; new sessions get an "Aico —" prefix; past sessions are "Recent" (web), `aico sessions`, `tether history`; Grants vs the "Approvals" tab. Pick one each. (M)
10. Hosts (3 machines) vs Status (8) vs New session (4): say what each list is ("Session hosts") or show every machine with power where it applies. (S)
11. Grants: Active and History sections; expired items stop reading as questions. (S)
12. Backups: summary line at top ("All 96 current, 36 archived"), group rows by source, load under 1 s (now 2.1 s). (S-M)
13. Agents page: move under Settings, plain words instead of "Loaded-context budget". (S)

## C. Sessions
14. New session: optional Name field, default to the last-used agent (not Codex), drop the stray "New chat" inside the dialog. (S)
15. Phone session header: title uses the free width, no overlapping pill/chevron; size banner says one consistent thing and "Use here" confirms what changed. (S)
16. Mode switch: a labelled control that says switching restarts the process; "Check in later" disabled with a tooltip for shells. (S)
17. Session rows show state: working, idle since…, needs you (with non-blocking asks on the row too). (S-M)

## D. Look and feel
18. One page frame and one set of tokens: Agents/Backups/Grants/Phone app/Logins use a second background (11,13,17) and old header; two ambers; h1 at 18/20/22 px in two fonts; mixed date formats; tab title just "Aico"; "Pair this phone" in the margin; sidebar disappears on those pages. (M)
19. Phone tap targets to 44 px (New session 36, Power on 28, Status pills 28, note box 22); Recent uses the full width. (S)

## E. Status
20. Order warnings by consequence (lost work and security before swap); session names instead of ids; Memory text not cut off, with a Resume action; Sudo row says which agent ran what. (S-M)

## F. CLI
21. `aico` is the one owner CLI with its own grouped help (today `aico --help` prints `st` usage and omits status/usage/agent/backup); `--help` works on every subcommand (lease, logs, models, prompt, context, tether sessions create/show fail or show the wrong help); errors say `aico`, not `st`; `aico backup` vs `backups`; `aico sessions` renamed `aico recent`; human output by default, `--json` on request (tether create dumps ~60 lines of JSON; backups list is one 55 KB line); remove "Aico window" from tether help. (M)
22. "ask" means a model call (`aico ask`) and an owner question (`tether ask`): rename the model call (`aico prompt-model` or `aico agent ask`). (S)

## G. For running many agents across machines (new)
23. "While you were away" digest on home and as one phone push per morning (not per event): finished, failed, stuck, new asks, problems, spend since last look. (M)
24. Spend per day per provider on the usage view, with the days-left estimate already in `aico usage show`. (S)
25. Recent row opens the transcript and the session's final reply. (S)
26. Recovery on the web: what died, what was resumed, one Resume button (today only `tether recovery status`). (M)

## H. Carried over (already known)
27. Trust dialog shows "No status"; "working, quiet N min" signal; sudo warning from summitflow-backup-window; dispositions not recorded; tether@.service waits for network-online; the web chat path doesn't skip used-up providers; flaky deploy lock test; leftover project memories for retired agent-hub, nightshift, summitflow. (S each)

## Then (already approved)
Performance and refactor run (Backups load, session open 2.5 s, any page or command over ~1 s), leftover sweep across repos.
