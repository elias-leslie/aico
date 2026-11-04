# M8b-2 mockup brief (builder: Opus 5.5 high, native subagent)

Goal: the mockup of Aico's chat screens, built on Aico's own agent harness (`packages/agent`), for the web app and phone. M8b-2 builds it once the owner reviews it. Design work only: a static, clickable HTML mockup, no product code.

Read first:
- `docs/plans/codebase-cleanup/cutlist.md`:
  - the `agent` row in 1.1 ("Aico chat sessions");
  - the M8b row in section 4: chat sessions in web and phone on `agent`, replacing Aico's unfinished Agent Hub chat (`web/server/src/agent-hub.ts`, `chat.ts`, `AgentHubChat.tsx`, now under `packages/web-server` / `packages/web-frontend`);
  - ah-13 in 2.1 (a message-renderer subset only if needed).
- `plan.md` "Standard agent interface for Aico" and the agent-hub section.
- What the harness can do today (`aico agent --help`, `aico agent show`, `packages/agent/src`):
  - runs per role and model;
  - resume, and branch at a turn;
  - compaction;
  - the model per turn, with provider-error fallback ("takes it as turn T+1");
  - typed refusals with handoff to another model;
  - tool calls (read, bash, edit, write) and withheld secrets;
  - token totals.
- The existing unfinished chat screen (`AgentHubChat.tsx`) and the sessions and transcript view from M8-2, for what to keep and what to drop.
- The Aico product standard in your context:
  - Lantern tokens and one dark theme; amber is the only accent, status lives in badges and chips, and ember is for danger only;
  - short transitions, and nothing animates at rest except a session waiting on the owner;
  - short phone labels with the keyboard open; never say "terminal";
  - lead with the session's state, then the one action that helps.
- Load the `design-evidence-review` and `product-copy` skills. Tokens and fonts: `packages/ui-kit/src/tokens.css` and `packages/ui-kit/fonts/`. Reference them; don't copy them.

Deliver, in `docs/mockups/chat/`:
1. Desktop:
   - a chat list (recent chats with role, model, state and last activity; a new chat that picks a role, with the model defaulting from routing);
   - a chat view with a streaming reply, tool calls folded to one line that opens, the model shown per turn, a fallback turn and a refusal handoff shown plainly, and token totals tucked away;
   - per-message actions: branch from here and copy.
2. The phone at 390px, with the keyboard open, plus attaching a photo or file (Aico's capture flow).
3. A chat waiting on the owner (the one thing allowed to animate at rest), and how it shows in the session list.
4. Loading, empty, failed (provider down), partial (a run stopped mid-reply), and resumed states, each with its own copy.
5. A short `NOTES.md`: what each part answers, the copy choices, what was cut from the old chat, and 2-4 real open questions for the owner, each with a recommendation.

Proof: render with `st browser` at desktop and 390px widths, and run `st uilint` if it applies. Show it with `st browser preview <file>`, leave it open, and give the session name. Share the folder with `tether share docs/mockups/chat`.

Commit with `st commit -m "..." --paths docs/mockups/chat`, ending with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Never git stash, reset, checkout or rebase. Never open the neri repo or any Neri data, or read credentials. Use made-up chat content, never real transcripts.

Report (≤20 lines): files, preview session name, open questions with recommendations, and screenshot paths.
