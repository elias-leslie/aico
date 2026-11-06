# Task rows carried into ROADMAP.md (2026-11-06)

The Aico task system is gone. Its 52 rows (38 were a same-day bulk import from SummitFlow, 13 only pointers to wiki or STATUS pages) were read once, and the still-real ones became lines in each project's ROADMAP.md. The task tables were dropped by a migration in ef9f1f0c. Pointer-only, done and stale rows were not carried.

| Project | Rows | Carried (section) | Dropped (why) |
|---|---|---|---|
| aico | 2 | Neri hunter VM placement (Next) | Nightshift unexplained-login-or-port notice (a notice, not work) |
| blackbox | 2 | FUSE mount for Plex and Jellyfin (Next) | Android encrypted-media CI repair (already fixed in e29c621) |
| bugout | 2 | GitLab CE 19.5.0 lab rebuild (Now), role-technique comparison (Next) | none |
| cinderwake | 6 | Owner playtest verdict (Now), voice acting and render (Now), slice polish and asset round 2 (Next), galaxy rebuild M2 to M6 (Later) | Rebuild M0-M6 row (folded into the overview and Later line) |
| codex-config | 3 | none | all three already done (ST roots in shell environments, computer use plugin, dangling zzconsult link) |
| jobinator-4000 | 2 | Applications to 1Password, Cohere and Tanium (Next) | VM 180 release-path row (Jobinator now runs in CT 191) |
| ominull | 20 | Grant signature gap and fuzzing, Topology and ESTATS checks (Now); Traffic overhaul, Rust parsing library, IP and CIDR rules, FQDN rules, code signing, posture port (Next); BloodHound, household router work, phases 2 to 4, umbrella direction (Later) | Upload budget (landed in 1.8.60); several direction-2026-10 rows merged into one Later line each |
| portfolio-ai | 2 | Net-worth cockpit and UX hardening (Now), Money panel fixtures and money revamp (Next) | none |
| other projects | 13 | nightshift (hand duties to Aico, Now; open-source export, Later), uilint (two Now/Next lines from PLAN.md) | pointer-only rows for monkey-fight, portfolio and vault-tools (nothing in flight in the repos) |

Projects with a ROADMAP.md and no lines: agent-skills, browser-automation, claude-config, code-intelligence, desktop-automation, monkey-fight, portfolio, vault-tools.
