# M2 mockup brief (builder: Opus 5.5 high, native subagent)

Goal: the mockup of the one Status screen that M2 builds once the owner reviews it. Design work only: a static, clickable HTML mockup. No product code.

Read first:
- `docs/plans/codebase-cleanup/plan.md` "Settled consolidation choices" -> "Status: one screen for the whole fleet". It gives the row fields, problems first with healthy rows folded into a count, the filters and sort, late and unknown, the row actions, detail pages only where there's real content, the screens it replaces, and the UI rule.
- The decisions log entry "One central Status screen".
- The Aico product standard in your context: Lantern tokens, one dark theme, amber as the only accent, status in badges/chips, ember for danger only, short transitions, nothing animated at rest, phone labels short.
- Load the `design-evidence-review` and `product-copy` skills.
- The contract: `contracts/status-row.schema.json` and `packages/status/src/show.ts`. The shown states are failed, late, unknown, warn, ok and off; a missing machine row reads "no word from X".

Inputs:
- Tokens and fonts: `packages/ui-kit/src/tokens.css` and `packages/ui-kit/fonts/`. Reference them; don't copy them or invent a palette.
- Look and density: the existing Aico web app (`packages/web-frontend`) and the live app at the local URL.
- Rows: real rows from `curl -s http://127.0.0.1:3002/api/status`, plus realistic made-up rows covering the kinds the screen must handle (check, job, backup, service, vm, machine, link, grant, repo) on davion-sidarli, davion-gem, CT 190, VM 180 and VM 200, with every shown state. Never invent anything about Neri or VM 201 beyond a plain "machine" row.

Deliver, in `docs/mockups/status/`:
1. The desktop Status screen: a problems-first list, a healthy count that unfolds, filters (state, kind, machine, project, search), sort, and per-row actions (run now, detail, log, look into it). One project page shows the same list, filtered.
2. The phone layout at 390px wide, with the keyboard-open case for search.
3. The tray badge and the phone notification summary, as small panels showing the same rollup.
4. Loading, empty ("no rows yet"), failed (API down), partial (one machine not answering) and stale states, each with its own copy.
5. One detail page where the plan says there's real content (backup restore), to show where the detail pages fit.
6. A short `NOTES.md` beside it: what each part answers, the copy choices, and 2-4 real open questions for the owner, each with a recommendation.

Proof: render with `st browser` at desktop and 390px widths, and run `st uilint` on it if it applies. Show it with `st browser preview <file>`; leave it open and give the session name. Share the folder with `tether share docs/mockups/status`.

Commit it with `st commit -m "..." --paths docs/mockups/status`, ending the message with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Never git stash, reset, checkout or rebase. Never open the neri repo or any Neri data.

Report (≤20 lines): files, preview session name, open questions with recommendations, and screenshot paths.
