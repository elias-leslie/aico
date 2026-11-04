# M6b brief (builder: Opus 5.5 high, native subagent). This is the gate for our own harness.

Goal: milestone M6b in /srv/workspaces/projects/aico. Build the first slice of `packages/agent`, Aico's own agent harness: a thin loop on pi-agent-core, run by `aico agent run --role R`. Then prove it against Pi.
- Pass: on the 16-check task and on one longer real task, our harness uses tokens at or below Pi's with the same context, and passes the same checks. An injected refusal hands off to the next model with the context kept. A blocked model is refused when the role rules can't be read.
- Fail: Pi's terminal app plus extensions becomes the main harness. Report honestly either way; the owner decides on the result.

Read first:
- `docs/plans/codebase-cleanup/plan.md`: the decisions-log entry of 2026-11-03 "Our own agent harness stays, rebuilt in TypeScript on Pi's libraries", plus "Settled consolidation choices".
- `harness-review/case-A.md` and `case-B.md`: the adversarial review. Its conclusions are binding.
- `cutlist.md`: 1.1 (`agent` is layer 4 and imports shared, store, status, context; `usage` doesn't exist yet, so leave it out), the M6b and M8b rows in section 4, and 4.1 (the Result rule).
- Evaluation: `/srv/workspaces/projects/agent-hub/docs/evaluations/multi-model-workflow-20261027/` (README results table, run.py) and its fixture and grader in `../harness-efficiency-20261022/`. Pi run 3 on gpt-6.1-sol: 16/16, 23,316 tokens total, 9 tool calls.
- Pi itself: the installed release under `~/.pi/agent/install/releases/` (packages @earendil-works/pi-ai, pi-agent-core, pi-coding-agent; docs in pi-coding-agent/docs).

Binding rules from the decision:
- Take Pi's providers (pi-ai), the loop core (pi-agent-core), the read/bash/edit/write tools and the compaction as exact-pinned npm libraries. Never fork, patch or vendor-modify them. Use our own lean tool descriptions.
- Register allowed providers only. Anthropic is never registered: Claude comes only through `claude -p`, which is not part of this slice.
- We own the following:
  - The loop policy.
  - Role rules from `@aico/context`: models, tool level, guard and egress. They fail closed: if the rules can't be read, nothing runs.
  - Typed outcomes, such as `refused` → handoff and `model_swap`.
  - In-conversation handoff.
  - Sessions written straight to SQLite: an `agent.db` owned by `agent`, through `@aico/store`.
- Auth: use pi-ai's own login and auth mechanism for the Codex/OpenAI provider. Never read, print, copy or log tokens or auth files yourself.

Scope:
1. `packages/agent` with `aico agent run --role R [--model M] "<task>"`, in the cwd. Route it through the `aico` script's allowed subcommands; `packages/web-server/scripts/aico` accepts only listed subcommands, so add `agent`.
2. Loop:
   - The model comes from `@aico/context` route() for the role, or `--model` if role rules allow it.
   - Tools: read, bash, edit, write.
   - Compaction is off unless the task needs it (M8b wires it in properly).
   - Transcript rows (turns, tool calls, usage tokens) go into agent.db.
3. Refusal handoff: when a provider refuses, the next model in the role's chain continues in the same conversation with a compact handoff that keeps the context, measured in tokens. Add a test hook that injects a refusal; it is on only when a test or flag sets it.
4. Fail closed: if context.db or the role rules are missing or unreadable, refuse with a typed reason. A model the role denies is refused (see `aico models route --role hunting --model fable`).
5. One Status row for the last agent run is optional. Skip it if it adds more than a few lines.

Proof:
- `st check --acceptance` before and after; unit tests cover the policy, fail-closed behavior, the refusal handoff (mocked provider) and the transcript.
- Live A/B on gpt-6.1-sol at high thinking, the same as the evaluation:
  - the 16-check fixture with our harness and with Pi (`pi`, fresh run, same day, same context files, no Agent Hub injection on either side);
  - one longer real task, a multi-file change graded by tests, run in a scratch clone under /srv/scratch on both harnesses;
  - report tokens disjoint (input, cache read, output), checks passed, tool calls and wall time per run, plus a table in the evaluation style.
- These runs spend a few Codex credits. That is expected; keep it to these runs plus at most one repeat per pair when their tokens differ by more than 15%.
- If gpt-6.1-sol is out of quota, wait for the reset (05:28 local); don't switch models. Write the table into `docs/plans/codebase-cleanup/harness-review/M6b-result.md`.

Rules:
- Commit with `st commit -m "..." --paths <files>`; end the message with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>".
- Hold leases. Other builders are in the repo (M3 jobs/notify, M5a host checks, M11a fleet link on Codex), so touch only your files plus wiring.
- Never git stash, reset, checkout or rebase.
- Never open the neri repo, Neri data or hunting sessions. The hunting role is M8b, not this slice.
- Lean: no features beyond the slice.

Report (≤30 lines): commits, LOC, the pass/fail table against Pi, the refusal-handoff numbers, the fail-closed proof, any Pi API pain found, and the verdict.
