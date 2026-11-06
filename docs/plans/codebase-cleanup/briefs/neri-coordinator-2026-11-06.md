# Neri coordinator: Aico cutover items (2026-11-06)

From: the Aico cleanup coordinator (session fa41c0c8). Owner approved starting you on 2026-11-06 and asked that the work be done by Opus 5.5 agents where possible, falling back to Codex gpt-6.1-sol xhigh. You coordinate; your own native subagents (or Aico lanes for another harness) do the work. Report to the owner through your session; file owner-only decisions as Aico asks.

## Goal
Move Neri and Neri Hunters off the Agent Hub pieces that still keep Agent Hub's backend and Postgres running, then confirm so Aico's coordinator can retire them.

## Work, in order
1. Lab-login switch. Read /srv/workspaces/projects/aico/docs/plans/codebase-cleanup/evidence/M11c/neri-switch.md (call mapping `st agents credentials ...` -> `st logins lab ...`, assignment model, request document). Switch every Neri/Neri Hunters caller. Before switching a running hunter: assign its targets (`aico logins assign SESSION --target T`) and make sure its machine has a grant. Note: lab entries are currently granted only to davion-sidarli and the aico container (CT 190), so hunters on VM 200/201 need machine grants first.
2. SDK wheel: install /srv/workspaces/projects/aico/native/st-sdk/dist/summitflow_st_sdk-0.2.1-py3-none-any.whl into Neri's own environment, refresh its lock, then run `st check --quick` in each repo.
3. Find every other remaining Neri dependency on Agent Hub (API calls, `st agents ...`, AH Postgres, hunting Pi route rows in agent-hub policy, session/history reads) and either switch it to the Aico equivalent or list it with the reason it must stay.
4. OmniNull tuning after the first ordinary hunting run (plan item): check what the OmniNull hub paged for VM 201 during a real hunt and tune any rule ordinary hunting sets off. VM 201 is monitor-only. Hub records about VM 201 are ordinary security data, not case data. If no hunt has run yet, say so and do it after the next one.
5. Question from an Aico review: does Neri's entry command ever exit 75 for anything other than missing prerequisites? Tether treats exit 75 as "not ready" and skips its crash-loop limits, so mapping agent crashes to 75 would bypass them. Answer yes/no with file:line.

## Report back
Write a short REPORT.md-style reply (in your session and as a file under neri's docs, your choice) with: what switched (commits), what still depends on Agent Hub and why, check results, the exit-75 answer, OmniNull tuning outcome. Then tell the Aico coordinator: `st sessions send fa41c0c8 "<one-line summary + report path>"` (or the current Aico cleanup coordinator if that session is gone).

## Rules
- Owner-only: credentials values (never print them), deleting backups/durable data, money.
- Don't stop Agent Hub or Postgres yourself; the Aico coordinator does that after your confirmation.
- `st commit --paths`, never stash or reset. Opus agents at medium effort.
- Nothing reaches our hosts from the internet except through Cloudflare (Access only).
