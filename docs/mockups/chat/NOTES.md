# Chat mockup (M8b-2)

Open `index.html` in a browser. The bar at the top switches views; it's mockup chrome, not product UI. The page is static: `data.js` holds made-up chats (no real transcripts), `chat.js` draws the views and the clicks (fold a tool call, Branch from here, Copy, New chat, Details, the + attach sheet, the answer buttons). "Now" is Wed Nov 4, 2:44 PM. Colours, fonts and easing come from `packages/ui-kit` (tokens.css, fonts); `chat.css` mirrors only the `.lantern-*` controls from the web app. Model ids and role orders are the ones `aico models route` gives today; Anthropic models never appear because the harness doesn't register them.

URL switches for screenshots: `?dialog=new#list`, `?details=1#chat`, `?branch=3#chat`, `?show-acts=3#chat`, `?still=1` (holds the streaming reply mid-sentence), and `?frame=phone&screen=list|chat|kb|attach|attached|waiting` (one phone screen at 390px).

## What each part answers

| View | Answers |
| --- | --- |
| Chat list | "Which chats need me, and what is each one doing?" Needs you first, then by last activity. Each row: state chip, title, the last thing said, role, the model that answered last, project, last activity. A chat is a session: it sits in the sidebar's session list with the same Needs you heading as the other sessions, marked with a chat icon. |
| New chat | Pick a role (one line on what it does), the model from routing (`gpt-6.1-sol, xhigh (from routing)`) with the rest of the role's order under it, a project folder, and the message. One line says why that model and who takes over if it can't answer. |
| Chat | State first (Working), then the one action (Stop). Each reply names its model and turn; hovering the model shows that turn's tokens. Tool calls are one line each (what ran, and a short result like `12 passed · 3.9 s` or `+18 −6`) and open to the output or the diff. A refusal handoff and a provider-error fallback are plain lines in the thread, with what the provider said folded under them. A call that names a credential path reads "Output not saved: credential path" and doesn't open. The reply streams in with a still caret; "glm-5.3 is writing…" under it. |
| Message actions | On hover or focus: Branch from here and Copy on replies, Copy on your messages. Branch opens a dialog that says what the new chat starts with, keeps this chat as it is, and asks for the new message and model. |
| Details | Token totals live here, out of the way: in, from cache, written to cache, out, and per model; tool calls; handoffs; summaries; start time; and `aico agent show RUN` to copy. |
| Phone | At 390px: the list, a chat replying, the keyboard open (the header shrinks to back, a short title and the state; the newest reply stays above the message box), the + sheet with Aico's capture choices (Camera, Photos, Files), and attachments uploading in the message box. |
| Waiting on you | The chat ended its turn with a question for you: a card with the answers as buttons (the recommended one marked) or "reply below". The header leads with Needs you and the one action, Answer. In the sidebar and the phone list the row sits under Needs you. Its border and chip glow slowly; that is the only motion at rest (off with reduced motion). |
| States | Loading (dashes, never 0), empty (a real zero with New chat), failed with every provider down (message kept, Try again), failed to open (not shown as an empty chat), partial (stopped mid-reply: the text kept and marked unfinished, Finish the reply), resumed (one line on who finishes the turn), disconnected (Reconnect, and what arrived until when), stopped by a model swap, and can't start because the role's rules can't be read. |

## Copy choices

- State words, one each: Needs you, Working, Idle, Stopped mid-reply, No model answered, Ended. The chip carries the state; amber is the only accent, the beacon is for Needs you, and ember is used only for No model answered.
- Handoffs say who, what, and that nothing was lost: "gpt-6.1-sol declined this turn (cyber policy). deepseek-v4.1-flash took it over with the whole chat; nothing above was lost." Fallbacks name the turn as the harness logs it: "deepseek-v4.1-flash didn't answer (provider error). glm-5.3 took the same request as turn 5 and goes on from here." Neither is styled as an error, since the chat goes on.
- "Declined" rather than "refused" in the thread: it reads as a model's choice, not a failure. The category stays as the harness gives it.
- Model ids are shown as ids (mono), never renamed. "Turn N" matches `aico agent show`.
- Phone labels stay short with the keyboard open: "Sends after this reply", "Sends when the photo is up", "Answer".
- Nothing says terminal, pane or tmux. Times are 12-hour, as the web app shows them.

## Cut from the old chat

From `AgentHubChat.tsx`, `ui-kit/src/chat/*` and the `@agent-hub/chat-ui` package (ah-13):
- The Agent Hub gateway and transport, the workflow-step read-only view (`run`/`step`), attempts and the stale-step note: workflow runs are gone.
- `@agent-hub/chat-ui` itself and its theme bridge in `chat.css`. M8b-2 needs only a small message renderer (text with code, a folded tool line, a diff), which the M8-2 transcript view's folded `<details>` rows already do. That is the "renderer subset only if needed": it's needed, and it's small enough to own.
- The model mentions (`@model`) and the free model catalog: the role's allowed models are the only choices.
- Kept: the model and effort selects in the composer, Stop giving queued messages back as a draft, the crash guard, and the "Opening the chat…" and "Try again" states.

## Proof

- Rendered with `st browser check` (local headless Chrome; the browser VM was down) at 1600×900 for every desktop view and dialog, and at 390×844 for each phone screen and each desktop view. No console errors. The states view reports "incomplete" only because its Loading card shows the word Loading.
- `st uilint` was skipped (coordinator: usage limit). Run `st uilint capture-script | st browser eval --stdin | st uilint check -` on each view before M8b-2 builds it.

## Open questions for the owner

1. **What makes a chat "Needs you"?** Every idle chat is waiting for its next message, so that can't be the signal or everything would glow. Recommendation: only an explicit question (the agent files a `tether ask`, shown as the card with answer buttons). An idle chat stays Idle and quiet.
2. **Where do chats live?** Recommendation: in the same sidebar session list as your Claude Code, Codex and Pi sessions (same Needs you heading), plus a Chats page for the full list and filters. No separate inbox.
3. **After a fallback, which model takes the next message?** The harness goes on with the model that answered last (glm-5.3 here), even though gpt-6.1-sol may be back. Recommendation: keep that within one reply, but start each new message from the role's first model again, and say so in the model select ("gpt-6.1-sol, role's first choice"). Today's behaviour would leave a chat on the third choice for good after one 502.
4. **Should a chat with Hunting or other contained roles be startable from the phone?** Recommendation: yes, the same New chat dialog. The role's rules decide what runs, so the phone needs no extra gate.

## Owner answers (2026-11-04)
1. Needs you: only a direct question the agent files (`tether ask`); idle chats stay quiet.
2. Chats sit in the same sidebar session list (same Needs you group), marked with a chat icon. No separate Chats page (owner 2026-11-04: drop it).
3. After a failure, the next message goes back to the role's first choice after an outage (provider error), but stays on the new model after a refusal.
4. Hunting-role chats can be started from the phone too; the role's own limits apply.
