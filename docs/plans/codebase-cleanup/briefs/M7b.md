# M7b brief. Part 2 of 2 of M7: context delivery. The builder is named in the coordinator's launch note.

Goal: Aico delivers each agent session's runtime context from `packages/context`, replacing Agent Hub's context delivery. The context is the project instructions, prompts, memories, the tool-usage block and the recent-activity lines. It goes out through one adapter per tool in `packages/tether`, under a byte budget, so that Agent Hub's delivery can be switched off.

Read first:
- `docs/plans/codebase-cleanup/cutlist.md`:
  - 1.1: `context`, layer 3: "context delivery, per-item inventory"; `tether`, layer 5: "one adapter per tool".
  - 2.1 rows ah-03 (context delivery and memory selection: rebuild), ah-17 and ah-38.
  - The M7 row in section 4.
- Source to port, as reference only: `/srv/workspaces/projects/agent-hub/backend/app/svc/runtime_context.py`, `runtime_prompt_stack.py` and the files they use.
- What gets delivered today:
  - the files under `~/.local/state/agent-hub/context-deliveries/<tool>/<project>/...`;
  - how each tool loads them (Claude Code `CLAUDE.md` additional dirs, Codex, Pi);
  - the SessionStart and UserPromptSubmit additions.
- `packages/context` (M6): memories with FTS5, prompts, roles and `route()`. The FTS5 choice is settled; memory selection follows Agent Hub's scope rules (global, project, agent), not search.

Scope:
1. `context.deliver({tool, project, session, role})` returns the ordered sections with a byte count each. A data-driven byte budget per tool cuts the lowest-priority sections first and reports what it cut.
   - The per-item inventory (what was loaded, its size) goes in context.db for the M9 cost view.
2. `aico context deliver --tool T --project P --session S [--format claude|codex|pi]` is the CLI that M7a's `aico-hook` calls. Add it to the `aico` script's allowed subcommands.
3. Tether adapters per tool (`packages/tether/src/lifecycle/tui/`):
   - write or inject the delivery in process when Tether starts a session;
   - a conformance suite runs every adapter against the same fixture contexts in `contracts/`.
4. Parity: for 3 real projects × 3 tools, diff Aico's delivery against Agent Hub's current files, section by section. Each difference is either fixed or explained (deliberate cut, smaller budget).
   - Measure effective context bytes before and after for each tool, following the prompt-development practice in your context.
5. Cutover:
   - point the tools at Aico's delivery: through M7a's hook, or the adapter for the CLAUDE.md dir;
   - switch Agent Hub's delivery off with its own knob or setting, without deleting its data;
   - Agent Hub keeps running for its other jobs until M8 and M9.

Proof:
- Tests for budget cuts, ordering, scopes and the conformance suite. Run `st check --quick --changed-only`, and `st check --acceptance` before and after.
- Live, for each tool: a fresh session shows the delivered context (ask the agent to quote one memory id and the project rule header), and `aico context deliver` output matches the adapter's file.
- The parity table and byte counts go in `docs/plans/codebase-cleanup/evidence/M7b-parity.md`.

Rules:
- Commit with `st commit -m "..." --paths <files>`. End each commit with your model's Co-Authored-By trailer, as given in the launch note.
- Hold leases. M7a works in native/hook and the claude-config repo at the same time.
- Never git stash, reset, checkout or rebase.
- Never open the neri repo or Neri data. Never read credentials, .env or auth files.
- If the rebuild needs a design call, stop and report.

Report (≤25 lines): commits, LOC, parity results, byte counts before and after, the cutover, and anything undone.
