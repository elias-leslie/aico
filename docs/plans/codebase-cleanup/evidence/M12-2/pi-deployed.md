# M12-2 fresh Pi session after model-guard swap

Checked 2026-11-05. Session: Pi 1.4.0, opencode-go/deepseek-v4.1-flash, effort max,
`AICO_SESSION_ID=aico-widget-ec76252d`, `AICO_PROJECT_ID=aico`,
`ST_WORK_ROLE=verification` (`ST_WORK_ROLE_SOURCE=tether:root:aico-root-60eeaead…`).

## 1. Project rules / runtime memories: arrived
System prompt carries the Aico project rules block, the runtime memories (G:02c79821 Aico naming/design,
G:c4b3f43b test-against-live permission, G:029fd551 rebuild-don't-migrate, plus the M: model-work memories),
the coding/prompt practice, and the skills list (design-evidence-review, product-copy, orchestrate, etc.).
No missing or truncated rule block observed.

## 2. `st pulse --brief`
```
- CRIT aico: Nightly GitHub publication: Exited 1: Publication: 0 pushed; 12 failed.
- CRIT aico: aico GitHub publication: Main has no local check at 3c4bc895ee.
```
Both are pre-existing publication failures, unrelated to this session.

## 3. `st check --quick`: PASS
`CHECK:PASS quick 0.1s (0 ran, 73 skipped)` — no changed paths owned by this session;
16 files changed by other agents/leases were left out of scope.

## 4. `st models route --role hunting --tool claude-code --json`: denied (confirmed)
`"allowed": false`, `"deny_reason": "Owner 2026-11-01: Claude never for active hunting or recon"`,
`"launchable": true`, `"use": false`. Exit 0 (JSON is informational).

## 5. model-guard symlink
```
~/.pi/agent/extensions/model-guard.ts
  -> /home/kasadis/.local/lib/aico/ops/packages/tether/integrations/pi/model-guard.ts
  realpath -> /home/kasadis/.local/lib/aico/releases/a9d4efb38e50dc8d7ff3732443541431ab15369b/packages/tether/integrations/pi/model-guard.ts
```
- `~/.local/lib/aico/ops` -> that same release; it is the newest host-install release (Nov 5 03:14)
  and matches repo HEAD `a9d4efb3`. So the link resolves under the **active Aico release**.
- Target file (157 lines) is byte-identical to the repo copy at `packages/tether/integrations/pi/model-guard.ts`.
- Loaded as expected: Pi auto-discovers `~/.pi/agent/extensions/*.ts` (docs/extensions.md); no extension
  load errors in this session's log. Hooks present: `session_start` (warn), `model_select` (revert to
  previous model), `before_provider_request` (abort); provider `anthropic` is always asked as the
  `claude-code` tool. Guard is active here because `ST_WORK_ROLE` is set.
- Sanity check of the lookup path for this session: `aico models route --role verification --tool pi
  --model opencode-go/deepseek-v4.1-flash --project aico` -> `allowed: true` (job `testing`).

## 6. No Agent Hub context extension
`~/.pi/agent/extensions/` holds exactly three entries: `aico-due.ts`, `aico-hook.ts`, `model-guard.ts`.
No file under `~/.pi/agent/extensions` or `~/.pi/agent/install` mentions agent-hub. `aico-hook.ts` is the
ST inbox/turn hook and `aico-due.ts` is the Tether due-line puller — neither injects Agent Hub context.

## Observation (not a failure)
`aico-due.ts` still resolves through the service release `cdc7b1ee…` (latest service release, Nov 4 13:53)
rather than the host-install release; its content is identical to the repo HEAD copy, so no drift today,
but the two install trees are one deploy behind each other.

No Neri material opened; no source edits, no credentials read.
