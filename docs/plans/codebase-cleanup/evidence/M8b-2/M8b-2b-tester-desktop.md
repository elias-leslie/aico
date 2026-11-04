# Aico desktop chat — real-user test report

Tester: m8b2b-tester-desktop (headless local browser, viewport 1600x900)
Site: https://aico.summitflow.dev
Project folder used: /srv/scratch/aico-M8b-2b-tester/desktop
Model chosen in New chat: opencode-go/deepseek-v4.1-flash (no Claude chat model used)
Chats created: 0927999c (original), 20d0e053 (branch of turn 4). Both ended by me at the end of the run.
Screenshots: /tmp/aico-m8b2b-shots/  (paths below)
Method: only the page (click/type/read) plus `st browser --help`; no source, tests or internal APIs inspected.

## Goal results

| # | Goal | Result |
|---|------|--------|
| 1 | Start a chat in /srv/scratch/aico-M8b-2b-tester/desktop | PASS (with friction, see F1/F2) |
| 2 | Get a reply | PASS |
| 3 | Ask it to ask me a direct question, answer under Needs you | **FAIL** (see P1) |
| 4 | Stop a long reply | PASS |
| 5 | Branch a reply | PASS |
| 6 | Read Details | PASS (see F5) |
| - | End every chat created | PASS — both chats show "Ended" in FINISHED |

---

## 1. Start a chat — PASS

"New chat" opens a dialog: Project folder (combobox, prefilled with the last project
`/srv/workspaces/projects/agent-hub`), Role (9 radios, Implementation preselected), Model,
Effort, Message, then Cancel / Start chat. I typed the scratch path into the folder field and
picked `opencode-go/deepseek-v4.1-flash`; Start chat became enabled and opened the new chat
(`?session=0927999c`) with my message already sent.

Evidence: `01-chat-started.png`, `02-first-reply.png`

Things that made this slower than it should be:
- F1: the folder field is a text-editable combobox but shows no hint that you can type a path,
  no suggestion list while typing, and no confirmation that the path exists. It accepts anything
  (I did not test a bad path).
- F2: the chat header afterwards shows the folder as just "desktop" and Details does not show the
  folder at all, so two folders with the same last segment would look identical.

## 2. Get a reply — PASS

Reply arrived within seconds as `Turn 1` under my message: "Ready — I'll leave all files untouched
and just help with the UI check." My instruction not to edit files was honoured.

Evidence: `02-first-reply.png`

Minor at this point: the model/effort pickers under the composer are disabled in every chat once
it has started, yet they still open a list of disabled options (see F3). The reply card's
"Branch from here" and "Copy" buttons are invisible until hover, so on first look a reply has no
controls.

## 3. Ask the agent to ask me a question for Needs you — FAIL

I asked: *"ask me one direct question that needs my own answer — two clear options, a
recommendation, and put it in my Needs you list so I can answer it there."*

What happened (two attempts, the second one explicitly naming the Needs you panel):

- The chat agent ran `ls -la /srv/scratch/aico-M8b-2b-tester/desktop` (shown as one collapsed
  `bash` line), then answered in chat: *"Quick flag first: I have no "Needs you" list — no tool
  here can queue an item for you, so the question is below in chat instead."*
- On the second attempt it was blunt: *"Plainly: I have no ask/approval tool. My only tools are
  file read, bash, edit, and write — there is no "Needs you" panel, sidebar, or task-queue
  integration available to me, so I cannot place anything there. Any claim I had would be false."*
- The Needs you button stayed "Needs you: no agent questions or approvals waiting" throughout.
  Nothing from my chat ever appeared there, so there was nothing for me to answer under Needs you.
- The panel does work in general: for a few minutes during the run the sidebar showed a
  "NEEDS YOU 2" group with two questions belonging to other sessions (the phone testers'
  "Phone chat check" / "Phone check" chats). Those were not mine and I did not open or answer
  them; they were gone again later in the run.

Conclusion as a user: I cannot get a decision surfaced in Needs you from a chat. The request
itself works fine in chat (it asked a clean two-option question with a recommendation), but it
sits inline in the transcript instead of in the panel the sidebar advertises.

Evidence: `03-question.png` (question in chat, Needs you badge empty),
`05-before-stop.png` / `06-after-stop.png` (sidebar NEEDS YOU group filled only by other
sessions' items, none from mine).

## 4. Stop a long reply — PASS

Asked for "the integers 1 through 3000, one per line, in a single code block".

- While it streamed: header badge "Working", a "Stop" button at the top right, the text footer
  "opencode-go/deepseek-v4.1-flash is writing…", composer Send became "Queue message" with
  "Sends after this reply".
- I clicked Stop partway: badge became "Stopped mid-reply", and a paragraph appeared under the
  header: *"This reply stopped at 4:48 PM. What arrived is kept and marked unfinished. Finish the
  reply picks up where the chat left off."* The "Stop" button turned into "Finish the reply".
- The kept text stops at 1705 of the requested 3000 numbers; the reply card is labelled
  `Turn 5 · unfinished`. Sidebar status for the chat became "Stopped mid-reply".

Evidence: `04-streaming.png`, `05-before-stop.png`, `06-after-stop.png`

Minor: the only Stop control is in the header, far from the composer; the composer next to the
pointer just says "Queue message", so at 1600px wide the stop action is a trip to the top right.

## 5. Branch a reply — PASS

"Branch from here" on `Turn 4` opened a dialog "Branch from turn 4" with the explanation *"A new
chat starts with everything up to the end of turn 4 (opencode-go/deepseek-v4.1-flash's reply). This
chat stays as it is."*, a message box, a model picker (defaulted to the same model), Cancel /
Start branch (disabled until you type).

Result: a new chat (`?session=20d0e053`) with the same folder, the title suffixed
", branch at turn 4", turns 1–4 carried over verbatim, and my new message answered as `Turn 5`.
The original chat was unchanged, still showing "Stopped mid-reply".

Evidence: `07-branch-dialog.png`, `08-branched.png`

Minor: outside Details there is no visible "branched from X" marker in the header (only the title
suffix), and the branch dialog does not say which chat the parent is; a parent link is only found
after opening Details ("Branched from turn 4 of 0927999c.").

## 6. Read Details — PASS

Details opens as a right-hand panel, closes with an X:
Started, Tokens in, From cache, Written to cache, Tokens out, Tool calls, Handoffs, Summaries;
then PER MODEL with one line per model; then RUN with a copyable `aico agent show <id>` line and
"Branched from turn 4 of 0927999c." for the branch; then End chat. Values update per chat
(the original showed 1 tool call, the branch 0).

Evidence: `09-details.png`

Problems in Details:
- F4: numbers look contradictory with no explanation of the period they cover. Original chat:
  "Tokens in 1,960", "From cache 2,816", "Tokens out 1,152" — cache reads exceed tokens in, which
  reads like a bug to a user. Nothing says per-turn vs whole-chat or what "From cache" counts.
- F5: the project folder is not shown anywhere in Details (only the header's short "desktop").

## Ending chats

"End chat" in Details ends the chat immediately with no confirmation; the composer disappears and
the only signal is the "Ended" badge in the header plus the chat moving into FINISHED in the
sidebar. No undo/reopen affordance is visible in the ended view (I did not test reopening).

Both chats I created are shown as "Ended" in FINISHED; Needs you is back to "no agent questions
or approvals waiting" and I left no asks of my own.

Evidence: `10-branch-ended.png`, `11-ended-view.png`, `12-original-ended.png`

---

## Findings summary (what I saw, no implementation guesses)

- P1 (blocking for the journey): a chat cannot put a question into Needs you. The agent says it has
  no ask/approval tool at all, and there is no affordance in the chat page to turn a question into
  a Needs you item. The panel itself was demonstrably working (it listed other sessions' questions),
  so the gap is on the chat side.
- F1 New chat folder field: prefilled with another project, typeable but with no hint that typing is
  intended, no suggestions, no existence check.
- F2 Header shows the folder as the last path segment only ("desktop"); full path never shown,
  not even in Details.
- F3 Model/Effort pickers in an open chat are disabled but still open a dropdown of dead options;
  the reason (model fixed at start) is not stated.
- F4 Details token/cache numbers can look impossible (cache > tokens in) with no labels for what
  period each figure covers.
- F5 Reply controls ("Branch from here", "Copy") only appear on hover — a reply looks uncontrolled
  at rest.
- F6 One user message produced two assistant cards, `Turn 2` (the `ls` tool call) and `Turn 3` (the
  answer), same minute. Turn numbers read as if two replies happened.
- F7 "End chat" has no confirmation and no visible reopen in the ended view.
- F8 The header title is truncated ("…") with no tooltip; the full opening message is only readable
  in the transcript.

No open questions from me; nothing left waiting on the owner.
