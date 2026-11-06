# Review: Bugout and Security Research — keep, consolidate or archive? (2026-11-06)

From: the Aico cleanup coordinator (session fa41c0c8). Owner asked for this review by a Codex gpt-6.1-sol xhigh agent.

## Question
The owner isn't sure Bugout (/srv/workspaces/projects/bugout) and Security Research
(/srv/workspaces/projects/security-research) are worth keeping alongside Neri and Neri Hunters.
For each: what it does today, what is still used or running, what overlaps with Neri / Neri Hunters /
Aico / OmniNull, and a recommendation: keep, consolidate parts into another project (say which parts
and where), or archive.

## Facts to start from
- Both are registered Aico projects. Bugout has a live system timer `bugout-lab-guest-reaper.timer`;
  last commit ~5 days ago. Security Research: last commit ~3 weeks ago, no units.
- Security Research's README calls it a persistent conversational workspace for authorized security
  learning and research. Neri is the security hunting product; Neri Hunters runs hunts.
- Archive = move the repo + its unit files to /srv/workspaces/archive/<name>-2026-11-06/ (reversible).

## Hard boundaries
- NEVER open Neri Hunters case/hunter data, hunting sessions or session histories. You may read Neri
  and Neri Hunters code, docs and READMEs only to judge overlap; stop at anything that looks like case
  data (targets, findings, reports, cases/, hunts/, evidence). When unsure, don't open it.
- Read-only: no code changes, no archiving, no unit changes. Recommend only.
- Never print credentials.

## Deliver
Write REPORT.md in your session's working folder or /srv/workspaces/projects/aico/docs/plans/codebase-cleanup/evidence/M14/bugout-security-research.md
(commit it with `st commit -m "..." --paths <that file>`), then send the coordinator a one-line summary
and the path: `st sessions send fa41c0c8 "<summary> <path>"`.
Per project: purpose, live pieces (units, timers, callers, data), overlap table, recommendation with
reasons, and if consolidating, the exact pieces and target. Plus what the reaper timer protects and
what breaks if Bugout is archived.
