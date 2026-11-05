# Fresh-harness Codex CLI proof

Date: 2026-11-05. Working directory: `/srv/workspaces/projects/aico`.
Instructions: `/srv/scratch/m10d1-codex-proof.md`.

The requested commands were exercised. `st check` failed; the other required commands succeeded. No fixes or additional checks were attempted.

| Command | Exit code | Short nonsecret result |
| --- | --- | --- |
| `st pulse --brief` | 0 | Returned a brief with existing CRIT/WARN health alerts, including publication, memory, backup, isolation, sudo-use and reboot notices. |
| `st check` | 1 | Full check: 17 ran, 1 skipped; Vitest failed. Reported failing test: “passes the versioned Agent Hub context to the Aico session helper”. Other reported checks passed or reused prior passes; Semgrep skipped for no local rules. Full-check duration reported as 115.5 seconds, after the lane wait. |
| `st logins list` | 0 | Returned `[]`. |
| `st agents hosts list` | 0 | Returned 14 host registrations. No individual hosts were opened. |
| Create scratch HTML via shell heredoc | 0 | Wrote `/srv/scratch/m10d1-codex-proof.html`, a small dark HTML page. |
| `st mockup add /srv/scratch/m10d1-codex-proof.html --project TEST-M10d1-codex --title "TEST codex CLI proof"` | 0 | Returned mockup and ask IDs, plus relative page and HTML URLs. |
| `tether ask withdraw fbef93e715dc` | 0 | `Withdrew ask fbef93e715dc.` This was the very next command after submission; no owner decision was requested. |
| `st sessions send --help` | 2 | Printed `ERROR usage: sessions send TO TEXT [--fyi] [--source-key K]`; used to determine the required delivery syntax. |

Mockup details returned by `st mockup add`:

- Mockup ID: `5cdd9de2309f`
- Ask ID: `fbef93e715dc` — withdrawn successfully
- Project: `TEST-M10d1-codex`
- Title: `TEST codex CLI proof`
- Page URL: `/mockups?project=TEST-M10d1-codex`
- HTML URL: `/api/mockups/5cdd9de2309f/html?project=TEST-M10d1-codex`

Usability observations:

- `st check` waited about 100 seconds for the shared heavy-work lane, emitting a wait notice roughly every five seconds before starting. No other process was interrupted.
- `st sessions send --help` returned usage as an error with exit code 2.
- The mockup command returned relative URLs without an origin, so the page URL cannot be used as a standalone absolute link from CLI output. No page was opened.

No source edits, manual project-file changes, credential reads, or Neri code/data/session access were performed. The authorized `st check` command itself reported generated `.dev-tools` detail artifacts; these were not opened. Only the scratch HTML and this report were intentionally written. Others' work was preserved.

Report delivery result follows.

- `st sessions send codex:869df5 /srv/scratch/m10d1-codex-result.md` — exit code **0**.

## Rerun after checkpoint ab783306

Date: 2026-11-05. Checkpoint supplied by the user: `ab783306`.
Working directory: `/srv/workspaces/projects/aico`.

Only `st check` was rerun. Exit code: **0**.

- Final result: `CHECK:PASS full 117.2s (17 ran, 1 skipped)`.
- Vitest: `CHECK:OK:vitest|117.1s`; all **3,528 tests passed**.
- Other reported checks passed or reused prior passes. Semgrep was skipped for no local rules.
- Depcruise passed and retained its notice about 30 stale known baseline violations; no baseline changes were made.

This rerun passed, superseding the earlier failed check result. No source edits, fixes, additional checks, or inspection of generated detail artifacts were performed.

- Rerun report delivery: `st sessions send codex:869df5 /srv/scratch/m10d1-codex-result.md` — exit code **0**.
