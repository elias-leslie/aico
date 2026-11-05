# M12-2 Claude Code fresh-user proof (Aico)

Date: 2026-11-05 (about 08:06 UTC). Project: /srv/workspaces/projects/aico. No source edited, no Neri material opened, no credentials read, no sessions ended.

## Results

- `st pulse --brief`: exit 0. Two CRIT items:
  - Nightly GitHub publication exited 1: 0 pushed, 12 failed.
  - aico GitHub publication: main has no local check at 3c4bc895ee.
- `st check --quick`: exit 0, `PASS quick 1.1s (0 ran, 73 skipped)`. Nothing was checked: 0 changed files in scope, 197 changed files left out as other agents' writes or leases. Treat this as no evidence about the working tree.
- `st models route --role hunting --tool claude-code --json`: exit 0. `allowed: false`, deny reason "Owner 2026-11-01: Claude never for active hunting or recon". Model and effort are null, so nothing launches. The command reads the routing table and a cached usage snapshot (statusline, observed 2026-11-05 08:04 UTC). I saw no provider request.

## Context

- Project rules loaded from `/home/kasadis/.local/state/aico/deliveries/159b5c74/CLAUDE.md`. Section headings present: Safety Directive; Runtime Memory (two blocks); Plain progress narration; Web Research Routine; Coding Development Practice; Product UI Design and Copy; Platform Context; Prompt Development Practice; tool-usage block.
- Runtime memories: present (the two Runtime Memory blocks).
- Delivery: the rules file sits in Aico's delivery directory, and the SessionStart system brief came from Aico's pulse. I did not start a new session, so this is the context the current session was given.
- Agent Hub degraded warning: none seen in loaded context.

## Gaps

- `st check --quick` reports PASS with zero checks run. A fresh user would read that as green. This is a usability finding.
- Both CRIT publication items are unresolved. Out of scope for this proof (no source fixes requested).
