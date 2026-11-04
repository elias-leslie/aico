# M8b-2a brief (Codex gpt-6.1-sol xhigh lane). Part 1 of 2 of M8b-2: chat sessions on Aico's own harness, desktop web.

Goal: in /srv/workspaces/projects/aico, the owner chats with Aico's own agent harness (`packages/agent`, built in M8b-1) from the web app. A chat is a session: it sits in the sidebar's session list with Claude Code, Codex and Pi sessions, under the same groups (Needs you, Working, Idle, Finished), marked with a chat icon. There is no separate Chats page. Aico's unfinished Agent Hub chat is removed. Part 2 (phone screens and a tester pass) is a separate brief; don't start it.

Read first:
- The approved mockup: `docs/mockups/chat/` (index.html, chat.js, chat.css, data.js) and `NOTES.md`, especially "What each part answers", "Copy choices", "Cut from the old chat" and "Owner answers (2026-11-04)". Build to it; the mockup's top bar is mockup chrome.
- `docs/plans/codebase-cleanup/cutlist.md`: 1.1 (layers, the `agent` row: it pushes session state and totals to Tether; Tether never reads `agent.db`), rows ah-13 (renderer subset) and the M8b row in section 4.
- `packages/agent` (runs, resume, branch, fallback, `aico agent show`), Tether's session list and history push (`PUT /v1/history/aico-agent/:run`), and the M8-2 transcript view in the web frontend (its folded `<details>` rows are the renderer to reuse).
- The old chat to delete: find `agent-hub.ts`, `chat.ts` and `AgentHubChat.tsx` under packages/web-server and the web frontend, plus `@agent-hub/chat-ui` and `ui-kit/src/chat/*` if nothing else uses them.

Scope:
1. Server: start a chat (role, model from `route()`, project folder, first message), send, stop (queued messages come back as a draft), branch from a turn, and stream replies to the web app. All through `packages/agent`; no Agent Hub gateway.
2. Fallback rule (owner answer 3): after a provider error, the next message starts again from the role's first model; after a refusal the chat stays on the model that took over. Show it in the model select ("gpt-6.1-sol, role's first choice"). Add the harness test.
3. Needs you (owner answer 1): only when the agent files a direct question (`tether ask`), shown as the answer card with buttons (recommended one marked) or "reply below". An idle chat stays Idle. Its glow is the only motion at rest, off with reduced motion.
4. Desktop web: the sidebar rows, New chat dialog, the chat view (state first, then the one action; model and turn per reply, tokens on hover; one-line tool calls that open to output or diff; handoff and fallback lines as plain text with the provider's words folded), message actions (Branch from here, Copy), the Details panel, and every state in the mockup's States view (loading with dashes, empty, all providers down, failed to open, stopped mid-reply, resumed, disconnected, stopped by a model swap).
5. Hunting and other contained roles start from the same dialog; the role's own rules decide what runs.
6. Delete the old Agent Hub chat code and anything only it used. Say what you removed.

Design and copy: Aico's product standard (CLAUDE.md runtime memory G:02c79821): Lantern tokens from shared/tokens.css, amber the only accent, ember only for "No model answered", short transitions, one dark theme. Copy as in NOTES.md "Copy choices". Run uilint on each rendered view: `st uilint capture-script | st browser eval --stdin | st uilint check -`.

Proof:
- Tests for the server routes, the fallback rule, Needs you from an ask, stop/draft and branch.
- `st check --quick --changed-only`; `st check --acceptance` before and after.
- Deploy: `st sessions may-disrupt aico`, then `st service rebuild aico --detach` (Tether restarts too if its code changed).
- Live, against the deployed app on a scratch project: start a chat with the default role (DeepSeek or GLM through OpenCode Go is cheapest), send two messages, stop one mid-reply, branch from a turn, open Details, and have the agent file a question that shows under Needs you; answer it. Screenshot each at 1600x900 into `docs/plans/codebase-cleanup/evidence/M8b-2/`. End every chat and session you create.

Rules:
- Commit with `st commit -m "..." --paths <files>` in plain words, ending with "Co-Authored-By: Codex gpt-6.1-sol <noreply@openai.com>". Never git stash, reset, checkout or rebase.
- Hold leases. A Codex checks lane (codex:d6d2ac) works in `packages/checks`, `native/hook/lease` and `packages/web-server/scripts/aico`; a Sonnet builder (M9-1) may be in `packages/context` and `packages/usage`. Stay out of their files; ask them by `st sessions send ... --delivery handshake`.
- Never open the neri repo, Neri data or hunting sessions. Never read credentials, .env or auth files.
- Don't use Claude models for chats in testing (the Claude weekly limit is nearly used up).
- If a piece needs a design call the mockup and NOTES don't settle, ask the coordinator (cc:a4e559).

Report (≤20 lines): commits, LOC added and removed, what was deleted, the live checks with screenshot paths, uilint results, tests, and anything undone.
