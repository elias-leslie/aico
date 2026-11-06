# W1-11: SummitFlow tasks and the last Nightshift items (2026-11-06)

## Tasks carried into Aico
38 still-real SummitFlow tasks were re-created in Aico's task store, each description starting
"Carried from SummitFlow task-… on 2026-11-06". A CLI bug first put them all under `aico`
(an inherited AICO_PROJECT_ID overrode `-P`); fixed in 2ba6d17c and the rows moved to their projects.

| project | tasks |
|---|---|
| ominull | 20 |
| cinderwake | 6 |
| codex-config | 3 |
| blackbox | 2 |
| bugout | 2 |
| jobinator-4000 | 2 |
| portfolio-ai | 2 |
| aico | 1 |

Not carried:
- Neri / security-research tasks: left to the Neri coordinator (Neri data is off limits to Aico).
- SummitFlow Amazon Photos migration and demo GIFs: SummitFlow is retired.
- Agent Hub, SummitFlow and automation tasks made obsolete by the consolidation.

## Nightshift item store
- The 20 "docs" in /var/lib/nightshift/items/items.sqlite3 are Nightshift runtime state
  (seen, done, resolved, owner_decisions, lookinto, tether_asks…), not documents. Nothing to carry;
  the file stays in the archive with the rest of Nightshift's state.
- Old open alerts (reboot required, lab VM isolation for a deleted VM, restarting units, Browser VM
  down…) are stale and superseded by Aico Status rows.
- Open critical item "Lab VM broke isolation" (2026-11-04, 10.20.0.114 -> workstation:7449/tcp):
  7449 is Tether's fleet link, which the labnet workers must reach. Handed to W0-1 to confirm the
  source is a labnet worker and make exactly that flow expected in the ported isolation check, while
  any other labnet escape still pages. Outcome recorded in W0-1's evidence.
