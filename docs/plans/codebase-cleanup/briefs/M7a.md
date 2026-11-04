# M7a brief. Part 1 of 2 of M7: the Go hook. Builder per the coordinator's launch note.

Goal: write `aico-hook` in `/srv/workspaces/projects/aico/native/hook`, one Go binary. It replaces today's command guard, lease hook and coordination hook for Claude Code, Codex and Pi. Deny words and rules live in data files. It must replay the guard corpus with the same decisions as today's guard before it is swapped in.

Read first:
- `docs/plans/codebase-cleanup/cutlist.md`:
  - 1.1 (native table: `native/hook`, Go, binary swap `~/.local/bin/aico-hook`; `contracts/` hook payloads and guard corpus);
  - 1.4 (Go: `go vet` + `go test`, run when `native/hook/**` or `contracts/**` changes);
  - 2.2 rows sf-28, sf-33 and sf-29;
  - the M7 row in section 4.
- The source to port: `/srv/workspaces/projects/summitflow/backend/app/svc/command_guard.py`, `_command_guard_helpers.py` and their tests; `backend/cli/commands/lease.py` and `backend/cli/lib/leases.py`.
- How each tool calls today's hooks: Claude Code settings and `/srv/workspaces/projects/claude-config/hooks/`, Codex's hook config, and the Pi extension under `~/.pi/agent/extensions/`.
- `packages/agent/src/tools.ts` (M6b) calls the guard too, so point it at `aico-hook` as well.

Scope:
1. `contracts/hook-payloads.schema.json` covers each tool's hook input and output (PreToolUse, PostToolUse, SessionStart, UserPromptSubmit or the tool's equivalent). Build `contracts/guard-corpus/` from today's guard tests plus real denied and allowed commands found in the guard's logs; never include secrets.
2. Guard: the same decisions as `command_guard.py`. The corpus replay must agree 100%, and every difference must be fixed or listed with the owner rule behind it. Deny words, paths and rules live in data files next to the binary. Fail closed only for a guard decision; if the hook itself crashes, say so plainly in the tool's output rather than silently allowing.
3. Lease: auto-lease each edited file, and warn on another agent's lease (`st lease` semantics: 30-minute idle release). Keep the lease store that `st lease` reads until M10a moves it.
4. Coordination: the overlap hints and handshake prompts the current hooks inject (find them). Keep the behaviour; make the code lean.
5. Context delivery: the hook calls `aico context deliver` (M7b builds it), passing the tool, project and session, and emits its output in the tool's format. Until M7b lands, call a stub that returns nothing. Agree the CLI contract by reading M7b's brief.
6. Swap: install the binary at `~/.local/bin/aico-hook` and point each tool's hook config at it. Commit config changes in the claude-config repo and anywhere else they live. Rollback means pointing the config back; say how.
   - Hooks run in every live agent, including the coordinator. Swap one tool at a time.
   - Check that a guarded command is still denied in a fresh session of that tool, then move to the next tool.

Proof:
- `go test`/`go vet`, the corpus replay at 100% (or the listed exceptions), and `st check --quick --changed-only`.
- Latency: p50 and p95 per hook call, against today's Python guard.
- Live, per tool: a fresh session where a denied command is blocked, an allowed one runs, an edit takes a lease, and a second session sees the warning.
- `st check --acceptance` before and after.

Rules:
- Commit with `st commit -m "..." --paths <files>`. End each message with your model's Co-Authored-By trailer as the launch note gives it.
- Hold leases; M7b works in packages/context and packages/tether at the same time.
- Never git stash, reset, checkout or rebase. Never open the neri repo or Neri data. Never read credentials, .env or auth files.
- If the port needs a design call, stop and report.

Report (≤25 lines): commits, LOC, corpus result, latency, the swap per tool, rollback, and anything undone.
