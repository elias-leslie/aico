# M10d1 fresh-harness CLI proof — claude-code (final release)

Session: fresh Claude Code (Haiku 5.5), cwd /srv/workspaces/projects/aico. No source edits, no project files modified by me, no credentials read, no Neri code/data/sessions opened. Earlier report preserved at `/srv/scratch/m10d1-claude-code-result.md`.

| Command | Exit | Short result |
|---|---|---|
| `st pulse --brief` | 0 | 2 CRIT items: (1) aico — Agent Hub import into Aico: "Import failed: st db query failed (exit 2): st: Unknown optio…"; (2) aico — Nightly GitHub publication: exited 1 (2 pushed, 2 failed) |
| `st check` | 0 | 17 ran, 1 skipped (semgrep: no_local_rules). All OK. vitest 3531 passed; python-host-tests 1217 passed; contracts-host-steward 166 passed. Took 114.6s. Full output: `/srv/scratch/m10d1-claude-final-check.out` |
| `st logins list` | 0 | `[]` (empty) |
| `st agents hosts list` | 0 | 14 hosts; 3 active (agent-work, neri-hunters, neri-local — all granted claude-code/pi/st), 11 revoked |
| `st mockup add /srv/scratch/m10d1-claude-final-proof.html --project TEST-M10d1-claude-code --title "TEST claude-code CLI proof"` | 0 | mockup id `5dc1931e6f35`, askId `4e73a1f75323`, state pending, session 8a1750a3. Output: `/srv/scratch/m10d1-claude-final-mockup-add.out` |
| `tether ask withdraw 4e73a1f75323` | 0 | "Withdrew ask 4e73a1f75323." |

- Mockup id: `5dc1931e6f35`
- Ask id (withdrawn): `4e73a1f75323`
- pageUrl: `http://127.0.0.1:3002/mockups?project=TEST-M10d1-claude-code`
- htmlUrl: `/api/mockups/5dc1931e6f35/html?project=TEST-M10d1-claude-code`
- Scratch file: `/srv/scratch/m10d1-claude-final-proof.html` (dark card, static, no decision requested)

## Differences from the earlier run (`m10d1-claude-code-result.md`)
- `st check` passed this time. The earlier run failed one vitest case (`src/secrets.test.ts`, `Login unavailable for this role, machine or target`). Not investigated; the failure did not reproduce in this run.
- `st pulse --brief` now shows 2 CRIT items instead of 1. The new one is the Agent Hub import failing on `st db query failed (exit 2): st: Unknown option`. This looks like a CLI flag mismatch in a migrated st command, but I did not investigate it.

## Usability problems
1. **`mockup add` creates a pending owner-facing ask.** The test ask appeared as a real pending decision until I withdrew it. There is no flag to create a mockup without an ask, so a verification run has to clean up after itself.
2. **Inconsistent URLs.** `pageUrl` is now absolute and points at `127.0.0.1:3002`, which an owner on another machine cannot open. `htmlUrl` is still host-relative. The earlier run returned a relative `pageUrl`. Neither form is directly usable by the owner.
3. **`st pulse --brief` output is cluttered.** Its header says "`aico pulse --brief` repeats it", and the Agent Hub item is truncated mid-word ("Unknown optio…").
4. **`st check` writes detail files into `.dev-tools/`** inside the project checkout on each run. That is the tool's normal behaviour, but it dirties the working tree.
5. **Slow full check.** `st check` takes about 2 minutes, dominated by vitest (about 115s).

## Notes
- The proof file named `/srv/scratch/m10d1-claude-code-result.md` as its report path. I wrote this report to `/srv/scratch/m10d1-claude-final-result.md` as instructed, and preserved the earlier report.
- Ask `4e73a1f75323` was withdrawn immediately after creation, as the proof requires. It was a test; no owner decision was made.
