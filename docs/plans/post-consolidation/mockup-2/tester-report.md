# Tester reports: mockup 2

Haiku user-tester, given only the file path and nine goals, desktop 1440 x 936, clicks counted from the default state (scrolling is not a click). Saved by the coordinator from the tester's reply.

Pass rule: every goal in 2 clicks or fewer from the default state, and no confusion on goals 1 to 4.

## Run 1

| # | Goal | Clicks | Result |
|---|---|---|---|
| 1 | What needs me | 0 | pass; confused: "Needs you 3" header vs "Needs you 1" session group |
| 2 | What's broken, worst problem | 0 (1 for the full list) | pass; confused: why Lost work ranks above Security |
| 3 | Working / idle / finished | 0 | pass; confused: Security hunt under Working says "quiet 14 min"; "3 finished 1 failed" unclear |
| 4 | Start a session | 2 | pass; confused: name stayed "New session", count stayed 9 |
| 5 | Quota | 0 | read fine; "Spend by day" and the top-bar quota pill looked like dead clicks; "2 used up" didn't say which |
| 6 | A project's roadmap | 2 | roadmap shown; "Open the plan" did nothing visible |
| 7 | Backups | 1 | pass; "Current" read as restore-verified though the drill skipped two sets |
| 8 | File on a question | 1 | pass; the file view hid the answer buttons |
| 9 | Pop notes out | 1 | in-page panel labelled "own window", no real window |

Verdict: clicks pass on all nine; confusion on goals 1 to 4, so **fail**.

Fixes made after checking each finding in the mockup:
- Needs you header says "3 · 2 questions · 1 grant"; the session group says "Needs you 1 · stopped until you answer".
- Worst problem says why it's first ("First because work was lost; security comes next"); Status says the ranking order.
- Security hunt reads "working, no output for 14 min" (item 27's "working, quiet" signal).
- Digest reads "3 finished, 1 of them failed".
- A started session raises the count to 10, Working to 4, and is labelled "named after your first message".
- Quota pill and "Spend by day" jump straight (no smooth scroll) to Quota and spend with a brief highlight; the pill names the used-up providers.
- "Open the plan" opens plan.md inside the roadmap.
- Notes open in a real browser window; the in-page panel is only the fallback when the browser blocks it, and says so.
- Backups say "up to date" and "restore last proven Nov 5", with a line on what each means.
- A file opened on a question sits above its answer buttons, which stay visible.

## Run 2 (fresh tester, after the fixes)

| # | Goal | Clicks | Result |
|---|---|---|---|
| 1 | What needs me | 0 | pass; still read "Needs you 3" (2 questions, 1 grant) vs the session group's "Needs you 1" as two counts for one idea |
| 2 | What's broken, worst problem | 0-1 | pass, ranking now understood |
| 3 | Working / idle / finished | 0 | pass; still asked whether "working, no output for 14 min" is stuck |
| 4 | Start a session | 2 | pass; the chat title "New session" and the row's "(named after your first message)" disagreed |
| 5 | Quota | 0 (1 for the chart) | pass; "OpenCode out" unexplained |
| 6 | Roadmap | 2 | pass |
| 7 | Backups | 1 | pass; "up to date" next to a stopped drill still reads as mixed |
| 8 | File on a question | 1 | pass |
| 9 | Pop notes out | 1 | pass, a real window opened |

Verdict: every goal in 2 clicks or fewer; light confusion remains on goals 1, 3 and 4, so by the written rule **not a pass**. The brief allowed one re-run, so no third run.
"Alco coordinator" in the tester's notes is a misread: the text is "Aico"; at small sizes the font's capital I next to "i" looks like "l".

Wording fixed after run 2 (not re-tested): the session group reads "Needs you · 1 session, stopped until you answer it"; the hunt reads "thinking, no output 14 min" under Working (Aico never treats silence as death); a new session is "New session" everywhere, with "renamed after your first message" on its row; the quota pill says "used up".
