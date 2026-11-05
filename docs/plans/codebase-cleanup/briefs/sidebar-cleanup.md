# Sidebar and Status cleanup (Codex gpt-6.1-sol high lane). Owner 2026-11-04: "kinda noisy... left overs?"

Goal: the sidebar shows only live sessions and real attention, and the Status badge counts only real problems. No ST task: track by leases and commits.

What the owner sees (phone, 2026-11-04 ~20:40): Sessions · 17, of which 14 sit under "Finished": ended test chats from the M8b-2 lanes ("Test phone chat", "Phone check...", "Hi. This is a scratch folder...", "Branch at turn 1..."), each "Ended". Ended Claude Code/Codex sessions leave the list; ended chats stay because a chat's turn finished and was never opened (`web-frontend/lib/attention.ts`, `components/SessionList.tsx`). Status shows 16.

Scope:
1. An ended chat leaves the session list like any ended session (still reachable in Recent and its history). "Finished" keeps meaning a live session whose turn ended unseen. Test it.
2. Clear the leftover test chats: they were made by agents for testing (M8b-2a/2b, scratch projects). End or archive them through the normal chat path so they're out of the list; keep their transcripts unless the chat path deletes nothing anyway. Don't touch any chat the owner started (check who started each; list them).
3. Agents' test chats from now on: a chat started for testing is marked so (e.g. started by an agent session, not the owner) and drops out once ended; testers end their chats.
4. Status 16: list every non-ok row with why. Fix rows that are wrong or noise, e.g. a worker VM that is idle-off by design shown as "waiting to connect" (should read off/idle, ok), stale rows from retired jobs, rows whose cause is already fixed. Real problems stay and get a one-line plain reason; list them in the report for the coordinator to route to owners. Don't silence real failures.

Proof: tests for the list rule and any Status row changes; `st check --quick --changed-only`; acceptance before/after; deploy (`st sessions may-disrupt aico`, `st service rebuild aico --detach`); live screenshot of the sidebar and Status at 390x844 into `evidence/sidebar-cleanup/` with uilint; the Status count before and after.

Rules: `st commit -m "..." --paths <files>`, trailer "Co-Authored-By: Codex gpt-6.1-sol <noreply@openai.com>"; never git stash, reset, checkout or rebase; hold leases; codex:7c9087 (Logins) and codex:89c941 (backups) are live: handshake before shared files; never open the neri repo, Neri data or hunting sessions; never read credentials; never type into the owner's sessions; one Codex-subagent review, fix findings with a failing test first; ask the coordinator (cc:a4e559) only for scope/design calls, never the owner. Coordinator's messages carry the brief's authority.

Report (≤12 lines) to cc:a4e559 as a handshake request: commits, the list rule, chats cleared (count), Status before/after with the real problems left.
