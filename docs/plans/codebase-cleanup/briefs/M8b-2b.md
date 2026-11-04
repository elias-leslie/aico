# M8b-2b brief (Codex gpt-6.1-sol xhigh lane). Part 2 of 2 of M8b-2: chat on the phone, then a tester pass.

Goal: the chats built in M8b-2a (desktop web, done: report in `docs/plans/codebase-cleanup/evidence/M8b-2/M8b-2a-report.md`) work on the phone as the approved mockup shows, and real-user testers can use them.

Read first:
- `docs/mockups/chat/NOTES.md` (Phone row, Copy choices, Owner answers) and the phone frames: `index.html?frame=phone&screen=list|chat|kb|attach|attached|waiting`.
- The M8b-2a commits `f38678b8`, `ddefecbd`, `41ec7f1a` and the web frontend chat code they added.
- How the phone reaches Aico today: the Android app in this repo (find it; M4 repointed it to the Aico API) and the web app at phone width.

Scope:
1. Phone at 390px: the sidebar list (Needs you first), a chat replying, the keyboard open (header shrinks to back, short title and state; newest reply stays above the message box), the + sheet with Aico's capture choices (Camera, Photos, Files), and attachments uploading in the message box. Short labels with the keyboard open.
2. Hunting and other contained roles can start a chat from the phone (owner answer 4).
3. Fix: replies show markdown bold as raw `**First**`; render the small markdown subset the transcript view uses.
4. Tester pass: run real-user testers given only what a user has (the URL, the goal, the page). Use Pi lanes on opencode-go/deepseek-v4.1-flash or the `user-tester` subagent pattern (Haiku); not Opus or Sonnet. Journeys: start a chat on the phone and on desktop, answer a question under Needs you, stop a reply, branch, read Details. A tester being confused is a finding against the design or copy: validate it live, then fix it.

Design and copy: as M8b-2a (Lantern tokens, amber only accent, short transitions, one dark theme; nothing says terminal). Run uilint on each rendered phone view.

Proof:
- Tests for anything with logic; `st check --quick --changed-only`; acceptance before and after.
- Deploy: `st sessions may-disrupt aico`, then `st service rebuild aico --detach`.
- Live on the deployed app at 390x844: each phone screen above, screenshots into `docs/plans/codebase-cleanup/evidence/M8b-2/` as `M8b-2b-*.png`; the tester reports and what you fixed from them.
- End every chat, session and browser you create.

Rules:
- Commit with `st commit -m "..." --paths <files>` in plain words, trailer "Co-Authored-By: Codex gpt-6.1-sol <noreply@openai.com>". Never git stash, reset, checkout or rebase.
- Hold leases; handshake other lanes (`st sessions send ... --delivery handshake`) before touching their files.
- No Claude models for chats in testing. Never open the neri repo, Neri data or hunting sessions; never read credentials, .env or auth files.
- One required review: a Codex subagent; the coordinator validates findings.
- Design calls the mockup and NOTES don't settle: ask the coordinator (cc:a4e559).

Report (≤18 lines) to cc:a4e559 as a handshake request: commits, LOC, screenshots, tester findings and fixes, uilint, tests, anything undone.
