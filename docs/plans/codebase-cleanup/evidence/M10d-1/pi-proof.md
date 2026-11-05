# M10d1 pi fresh-harness CLI proof — result

- Date: 2026-11-05 (UTC)
- Working dir: /srv/workspaces/projects/aico
- Harness: fresh pi session (no prior ST state)
- Constraints observed: no source edits, no credential reads, no Neri code/data/sessions, no project file modifications.

## Command results

| # | Command | Exit | Short nonsecret result |
|---|---------|------|------------------------|
| 1 | `st pulse --brief` | 0 | Brief returned 1 CRIT: "Nightly GitHub publication: Exited 1: Publication: 2 pushed; 2 failed." |
| 2 | `st check` | 1 | Full-tree check: 17 ran, 1 skipped, 1 failed. `vitest` failed (117.0s): 1 test failed / 3526 passed. Failing test: `src/secrets.test.ts` → "stores pushed logins privately and supplies them to the tool environment without changing the parent"; `LoginStore.require` threw `LoginError: Login unavailable for this role, machine or target`. All other reported checks OK (gitleaks, ruff, types, osv, tsc, biome, depcruise, boundaries, ui-spec, python tests, etc.). Detail file: `.dev-tools/vitest-4008366-details.txt`. |
| 3 | `st logins list` | 0 | Returned empty array `[]`. |
| 4 | `st agents hosts list` | 0 | Returned JSON `{"hosts":[...]}` with 14 hosts, 3 not revoked (`agent-work`, `neri-hunters`, `neri-local`). |
| 5 | `st mockup add /srv/scratch/m10d1-pi-proof.html --project TEST-M10d1-pi --title "TEST pi CLI proof"` | 0 | Created mockup; see IDs below. |
| 6 | `tether ask withdraw 98deb4fdd229` | 0 | `Withdrew ask 98deb4fdd229.` |

## Scratch mockup artifact

- File: `/srv/scratch/m10d1-pi-proof.html` (small dark-themed HTML page; only file created for this proof)

## Mockup-record IDs (exact values returned)

- mockup id: `4c87a2a8424e`
- ask id: `98deb4fdd229`
- project: `TEST-M10d1-pi`
- title: `TEST pi CLI proof`
- state at creation: `pending`
- session: `00a69966`
- page URL: `/mockups?project=TEST-M10d1-pi`
- html URL: `/api/mockups/4c87a2a8424e/html?project=TEST-M10d1-pi`
- ask withdrawal: performed immediately after creation using the exact returned askId (exit 0); this was a test, not an owner decision.

## Usability problems

1. `st check` does not pass on this checkout: `vitest` fails on the login-environment test with `LoginError: Login unavailable for this role, machine or target`. Because `st logins list` returns `[]`, the failing test looks environment/login-state dependent, so a fresh harness cannot get a green `st check` without local login setup. The single-line failure hint is useful but the full trace only appears in the `.dev-tools` detail file.
2. `st mockup add` returns the page and HTML links as relative paths (`/mockups?project=...`), with no absolute base URL. Opening the page URL directly requires knowing the service origin, which is not printed.
3. `st pulse --brief` reports a CRIT (nightly GitHub publication failures) without a command hint or detail pointer in the brief itself; the operator must discover where to look.

## Follow-up rerun after checkpoint ab783306

- Date: 2026-11-05 (UTC), same session and working dir (`/srv/workspaces/projects/aico`)
- Context: checkpoint `ab783306` committed; the expected failing CLI regression and inherited-role fixture were reported fixed.
- Scope: reran **only** `st check`; no source edits, no project file changes, no other checks.

| Command | Exit | Short nonsecret result |
|---------|------|------------------------|
| `st check` | 0 | `CHECK:PASS full 117.1s (17 ran, 1 skipped)` — all reported checks OK, including `vitest` (3528 passed / 0 failed, 117.0s). Detail file: `.dev-tools/vitest-4073340-details.txt`. |

- Resolution: previously failing `vitest` login-environment test now passes; usability problem #1 above is resolved by checkpoint `ab783306`. Problems #2 and #3 were not re-tested and remain as observations.
