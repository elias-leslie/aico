# Phone tester report — aico.summitflow.dev at 390x844 (M8b-2b)

Tester: m8b2b-tester-phone (Pi, local headless Chrome, own session `m8b2b-tester-phone`, viewport 390x844)
Method: only the page plus `st browser --help`. No source, tests, or internal APIs read.
Chats created (both ended by me): `2e08298c` (original, folder `/srv/scratch/aico-M8b-2b-tester/phone`) and `5131e230` (branch of 2e08298c at turn 22).
Model used in every turn: opencode-go/deepseek-v4.1-flash.
Needs you state at end: "Needs you" empty, `tether ask list --mine` -> No asks.
Screenshots: `/srv/scratch/aico-M8b-2b-tester/phone/01..19-*.png` (all 390x844).

## Goal results

| # | Goal | Result |
|---|---|---|
| 1 | Start a chat in /srv/scratch/aico-M8b-2b-tester/phone at 390x844 | PASS (with friction: folder path had to be typed) |
| 2 | Get a reply | PASS |
| 3 | Ask it to ask me a direct question, answer under Needs you | PASS on the second attempt — first attempt produced only chat text, nothing in Needs you |
| 4 | Stop a long reply | PASS |
| 5 | Branch a reply | PASS |
| 6 | Read Details | PASS visually, FAIL as readable text (panel content missing from the text/accessibility snapshot) |
| — | End every chat I created | PASS — both now show "Ended" in the sessions list |

## What happened, per goal

1. Home at 390x844 shows "No session open", New session, New chat, then WORKING / IDLE / FINISHED groups. New chat opens a sheet: Project folder (defaults to `/srv/workspaces/projects/agent-hub`), 9 roles, Model, Effort, Message. I typed `/srv/scratch/aico-M8b-2b-tester/phone`, picked `opencode-go/deepseek-v4.1-flash, high`, sent "Phone check. In one short line, greet me and name the folder you are working in." (01-home, 02-new-chat-sheet, 03-chat-filled)
2. Reply arrived in a few seconds: "Hello! I'm working in /srv/scratch/aico-M8b-2b-tester/phone." (04-first-reply)
3. First ask attempt: "ask me one direct yes/no question ... so it appears under Needs you, then wait." The agent answered in plain chat text only; Needs you still said "no agent questions". I then sent "That question only showed up as chat text. Nothing appeared under Needs you. Please file it as an Aico question ...". The agent then ran ~10 shell commands (reading `/srv/workspaces/projects/aico` docs, `tether ask --help`, `tether --help`, the aico repo, and even my own screenshot PNGs in the folder) before it filed an ask. The ask then appeared: session view showed "Question from this chat / It's waiting for your answer" with "Yes, explore first (recommended)" / "No, hold off"; sessions list gained a NEEDS YOU group and the Needs you button read "Needs you: 2 agent questions waiting". I opened Needs you, chose "Yes, explore first", pressed Send; it confirmed "Saved for "…": Yes, explore first." and Needs you went to 0. (05-question-in-chat, 06-question-card-in-chat, 07-sessions-needs-you, 08-needs-you-dialog)
   Note (context, not a finding): mid-test the coordinator withdrew that ask, so the chat agent later reported it as "withdrawn with answer 'Yes, explore first'". The answer text did reach the chat.
4. Stop: asked for a 1,200-word reply, clicked Stop in the header while it streamed (09-streaming-before-stop). Header became "Stopped mid-reply" with a "Finish the reply" button, the reply is labelled "Turn 22 · unfinished", and the text kept up to the cut (10-after-stop).
5. Branch: "Branch from here" on turn 22 opened a dialog "Branch from turn 22" explaining that a new chat starts with everything up to the end of turn 22 and this chat stays as it is, with a message box, model picker, Cancel/Start branch (12-branch-dialog). Start branch created a new chat titled "…, branch at turn 22" with the earlier turns replayed and answered (13-branch-chat).
6. Details (the ⓘ in the chat header) opened a panel: Started 4:52 PM, Tokens in 22,766, From cache 0, Written to cache 0, Tokens out 2,812, Tool calls 0, Handoffs 0, Summaries 0, PER MODEL opencode-go/deepseek-v4.1-flash with 22,766 in / 0 from cache / 2,812 out, RUN `aico agent show 5131e230` with a copy button, "Branched from turn 22 of 2e08298c.", and an End chat button (14-details, 16-details-reopen).

## Problems I hit (exact, as seen)

1. **Asking for a question does not land under Needs you.** "Ask me a direct yes/no question ... so it appears under Needs you" produced a chat sentence, not a Needs you item; Needs you still said "no agent questions or approvals waiting". Only after I complained did the agent go hunting (shell commands, repo docs, `tether --help`, my screenshot files) and file one. A phone user has no way to know the difference between an answer-in-chat question and an Aico ask.
2. **The ask card says "No session will get the answer"** under every question, while the same sheet's header says "2 agent questions · 2 waiting sessions" and "agent is waiting" on each card. Contradictory and alarming; I nearly stopped to check whether my answer would be delivered.
3. **Answering changes status without telling me.** After Send, the sheet said "Saved for "…": Yes, explore first." then "0 agent questions" / "Nothing else waiting." The question I had just answered was not visible anywhere in Asks; I only found out what happened when the chat agent described it as withdrawn.
4. **Browser tab title grammar:** "Aico · 2 need you" and then "Aico · 1 needs you" (mixed agreement). Low impact, visible on the phone's tab list.
5. **Chat has no name of its own.** The header h1 is the whole first message, cut to "Phone check. In one short line, gre…". On the sessions list both my chats read identically "Phone check. In one short line, greet m…" — the branch suffix ", branch at turn 22" is truncated away, so a branch is invisible in the list and in the chat header. I could not tell my two chats apart.
6. **Turn numbers disagree.** The branch dialog said "Branch from turn 22"; in the new chat the agent reported "this branch starts from turn 6 — your 1,200-word harbour-town request". Two numbering schemes on one concept, confusing when the branch point is the thing being chosen.
7. **Branch from an unfinished reply is ambiguous.** Turn 22 was stopped mid-sentence ("…and the sun turns into something"). The branch copy says "everything up to the end of turn 22 (…'s reply)" but never says the truncated reply is included. In practice the brushed chat replayed it and the next reply first regenerated the same prose before answering my one-line message.
8. **Details panel is not readable as text.** The ⓘ panel renders visually (14-details) but does not appear in the accessibility/text snapshot — the snapshot only offered the "Details: tokens, models, run" button. I could read the values only from the image. Bad for screen readers and for anything that reads the page as text.
9. **End chat is instant and hidden behind ⓘ.** No confirmation, no "this session will stop" copy; the chat flipped straight to "Ended". It sits in the Details panel while Stop is in the header, so the destructive control is the less visible one.
10. **Starting a chat in a folder is typing work.** The New chat sheet pre-fills `/srv/workspaces/projects/agent-hub` and there is no list of recent folders; at 390px I had to type `/srv/scratch/aico-M8b-2b-tester/phone` by hand. A phone user starting a chat in the wrong project is one typo away, and the chat view itself never shows the folder.
11. **Composer controls are cryptic at phone width.** Bottom row reads "opencode-go/deepseek…", "From rou…", "Next turn" — model and effort are truncated to the point of ambiguity, and the trailing label changed between "Next turn" (idle) and "Sends after this reply" (while working) without explanation.
12. **Very long replies are one flat paragraph.** The 1–400 answer rendered as one text block with no code/pre formatting and no collapse; at phone width that is a wall of numbers between my message and the composer.

## What worked well

- Stop is discoverable: it replaces the header action while working, and afterwards the state is explicit ("Stopped mid-reply" chip, "Turn 22 · unfinished", "Finish the reply").
- The branch dialog explains in one sentence what a branch does and that the source chat stays unchanged.
- Needs you groups sessions (NEEDS YOU above IDLE/FINISHED), shows "agent is waiting" and a note field, and "Saved for "…": choice" confirmed my answer.
- Details gives tokens, per-model split, run command, branch origin and End chat in one place.
