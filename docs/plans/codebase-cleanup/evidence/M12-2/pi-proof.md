# M12-2 Pi fresh-user proof (Aico)

Date: 2026-11-05 (about 08:18-08:25 UTC). Host davion-sidarli, project `/srv/workspaces/projects/aico`.
Session `pi:cb0b450e-48f2-469f-b4de-2aff79cbf20d` (`aico-widget-6f0d5afb`), work role `verification`, model deepseek-v4.1-flash (xhigh), started by Aico.
No source edited, no Neri repository/data/hunting session opened, no credentials read, no other session ended.

## Results

- `st pulse --brief`: exit 0. Two CRIT items, both pre-existing publication problems:
  - Nightly GitHub publication exited 1: 0 pushed, 12 failed.
  - aico GitHub publication: main has no local check at 3c4bc895ee.
- `st check --quick`: exit 0, `PASS quick 0.1s (0 ran, 73 skipped)`. Nothing was checked: 0 changed files in scope; 15 changed files were left out as other agents' writes or leases. A repeat with `--changed-only` reported "reused: the same content passed" (no new run). Treat this as no evidence about the working tree, not as green.
- `st models route --role hunting --tool claude-code --json`: exit 0, `allowed: false`, deny reason "Owner 2026-11-01: Claude never for active hunting or recon". Model and effort are null, so no launch config exists. Denial is data in the JSON, not an error exit.
  - No provider request: the command reads the routing table plus cached usage from Aico's local `usage.db` (`packages/context/src/route.ts` attachFacts, `packages/usage`), and a denied row skips the refusal lookup (`last_refusal: null`). The usage snapshot it printed predates the call (weekly reading observed 2026-11-05T08:04:47Z, facts_as_of 08:16:27Z; the 5h reading is from 2026-10-31).
- Tree: `git diff --stat` empty and the same 15 untracked evidence files as before this session, so this proof changed no tracked file.

## Context delivery (fresh Pi)

- Delivered by Aico, not Agent Hub: `~/.local/state/aico/deliveries/6f0d5afb/context.md` (25,283 of 32,768 bytes) and `delivery.json`; hash 43dc76be… equals `AICO_CONTEXT_DELIVERED` in this session's environment. Delivery record: `missing: []`, `over: false`, `cut: []`, project aico, role verification, tool pi.
- Section headings present: Safety Directive; Runtime Memory (two blocks); Plain progress narration; Web Research Routine; Coding Development Practice; Product UI Design and Copy; Platform Context; Prompt Development Practice; Tool Usage.
- Runtime memories: present, 14 entries (12 global `[G:]`, 2 `[M:]`).
- Agent Hub degraded warning: none. The delivered context contains no "degraded" text, and `AICO_ROOT_AGENT_HUB_CONTEXT` is empty, so the AH delivery path was not in play.

## Gaps (not fixed, out of scope)

- `st check --quick` says PASS while running zero checks. A fresh user reads that as green; it is only a scope statement.
- Both CRIT publication items are still open and belong to the M12 lane, not this proof.
