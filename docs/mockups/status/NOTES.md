# Status screen mockup (M2)

Open `index.html` in a browser. The bar at the top switches views; it's mockup chrome, not product UI. The page is static: `rows.js` holds the rows, and `status.js` applies the late and unknown rules, filters, sort and rollup the same way `packages/status/src/show.ts` does. "Now" is fixed at Tue Nov 3, 8:25 PM. Colours and fonts come from `packages/ui-kit` (tokens.css, fonts); `mockup.css` copies only the `.lantern-*` control styles from the web app so it looks like the app.

Rows: the four davion-sidarli rows marked "real" in `rows.js` came from `GET /api/status` on 2026-11-03. The other 27 are made up so every kind (check, job, backup, service, vm, machine, link, grant, repo), every shown state, and the machines davion-sidarli, davion-gem, aico (CT 190), apps (VM 180), agent-work (VM 200) and neri-hunters (VM 201, a plain machine row and nothing else) all appear.

## What each part answers

| View | Answers |
| --- | --- |
| Status screen | "Is anything wrong, and what do I do about it?" The rollup chips (which are also the state filters), then the problems: failed, late, unknown, warn. Healthy rows fold into one line ("21 healthy · 16 OK, 5 off") that unfolds. Search, kind, machine, project and sort sit in one row. Click a row to see its id, times and the exact run and log commands. The actions are Look into it, Run now, Log and Detail, and the one that helps most is highlighted: Look into it for failed and warn, Run now for late, Hosts for unknown. |
| Project page | "How is this project doing?" The same list, with the project filter fixed (aico). |
| Phone | The same list at 390px: chip and short time on the right, meaning cut to two lines. Search and filters sit behind two icons. With the keyboard open, the header gives way to the search field and a "4 matches · 1 problem" line. Tapping a row opens a sheet with full-width actions. |
| Tray and phone alert | The rollup outside the app. The tray badge counts problems and takes the colour of the worst one, and its menu lists the top three. The phone alert leads with what failed and then the rest of the rollup. The CLI prints the same rollup line first. |
| Page states | Loading (dashes, never 0), empty ("No rows yet": a real zero), failed (the API is down: a dash, and nothing counts as healthy), partial (davion-gem's machine row went late, so its rows show unknown since then, with a Hosts button) and stale (the last rows kept, with how old they are and a Refresh button). |
| Backup restore | Where a detail page fits: copies listed by the age of their data, not of the upload (the CT 150 rule), restore to a folder (the default) or over the live database (ember, asks again), the exact command, and the last restore test. |

## Copy choices

- Lead with the state, then the reason. Late rows say "Didn't report when due." before "Last report: …". Unknown rows give the cause first ("apps is off, so this can't report." or "Aico hasn't heard from agent-work itself.") and then the stale meaning. Unknown is never shown as ok or 0.
- Times read "Late since 4:30 AM", "Unknown since yesterday 4:51 PM" and "No word from agent-work", as the contract says. The phone uses weekdays ("since Mon 4:51 PM") to stay short. Times are 12-hour, as the web app shows them; the CLI keeps 24-hour.
- State words: Failed, Late, Unknown, Warning, OK, Off. Rollup: "10 problems: 2 failed, 2 late, 3 unknown, 3 warnings", matching `st status`'s "No problems: …" form.
- Colour: ember only for failed and the destructive restore choice; beacon amber for late and warn (late gets a ring, warn a diamond); unknown is a dashed neutral; ok is jade; off is a hollow mist ring. Lantern amber is kept for the primary action and focus.
- Run now is disabled on unknown rows, with the reason in its tooltip ("apps isn't reporting, so it can't run now").
- Nothing animates at rest. Sheets and dialogs use the 0.18–0.24s ease tokens; Run now shows "Running" for a moment, then a toast.

## Proof

- Rendered with `st browser check` (local headless Chrome) at 1600×900 and 390×844 for every view, plus the phone frames (`?frame=phone`, `&kb=1`, `&sheet=…`) and the expanded-row, Log and Look into it interactions at 1280 wide. No console errors.
- `st uilint check` on the rendered screen, states, tray and restore views: the luminance, font and banned-word rules pass. The only hits are `copy.name-aico` matching real ids: CT 190's host name `aico`, the project slug `aico`, and the `aico` CLI. When M2 builds the screen it should show machine and project ids as ids, and the rule should skip those slots. The rule isn't changed here.

## Open questions for the owner

1. **Which changes send a phone alert?** Recommendation: a row turning failed, or a backup or machine row going late, sends one alert per batch of changes, as shown. Warnings and unknowns only change the tray badge and the screen.
2. **Should rows on a machine you turned off on purpose count as problems?** Today apps (VM 180) is off by your choice, so its two rows sit in Problems as unknown and add 2 to the badge. Recommendation: still show them as unknown (it's honest), but leave them out of the badge and the phone alert while their machine row says off. They'd start counting again if the machine row goes late instead.
3. **Where does Status live?** Recommendation: a full page in the main area. Its sidebar button replaces today's "Health OK" and shows the problem count in the worst state's colour. On the phone, the same button opens it full screen. Needs you stays its own button.
