# Real-user round 7: after round 6's fixes, routine rows, Files, Notes, New session, Logins

Haiku testers at 390 and 1440 wide, given a goal and evidence/user-test-7/RULES.md; lib.cjs stubs Needs you, approvals and logins, and shows only Aico's sessions and zz-test- notes. Findings were checked live before any change.

## Why routine rows "wouldn't open"

Not a bug. Rows 0, 1, 5, 20 and 40 all opened by tap and click at both sizes and stayed open through 70 s of polling. They sit three folds down (System, Routines, group); on the phone behind the menu too. A failed or running row starts open, so a click there closes it. Earlier rounds just didn't get to them. A real look found what's below.

## Fixed

| Area | What the tester hit | Fix |
|---|---|---|
| Routines | "Nov 9, 6:30 AM" beside "Mon 4:40 AM", both tomorrow | Tomorrow always names the day |
| Routines | A long name stayed cut in an open row | The open row shows the whole name |
| Routines | "Sundays at 05:15 UTC (12:38 AM here)": a timer's random delay moved the scheduled time | The here-time is the scheduled time |
| Routines | "12:15 AM here · next 12:38 AM" with no reason | "(23 min random delay)" on the next run |
| New session | Pi showed nothing though its subscription was used up | Pi carries OpenCode Go's label, and the tooltip names OpenCode Go |
| Logins | Activity said "changed" beside a Replace button | "replaced" |
| Logins | "Replaced: Not recorded" | "Not replaced yet" |
| Notes | Delete warning named items and photos a note didn't have | Names only what this note has |
| CLI | `aico away`: unknown command | The launcher routes it; a test fails when it misses a command |

## Not defects

- Desktop Files and Notes open a separate window; the tester's first script didn't watch for it.
- Photo upload 400 and "No notes yet" above Groceries come from the helper.
- "add" in login activity and activity order are the stub's.
- "0 failed" red chip is dimmed on purpose. "Not now" carrying typed words and Find clearing on a folder change are round 3's choices.
- "All roles" ticked beside a role: each ticked role can be unticked to block it.
- Run now below the fold in a phone row: it scrolls.
- "Pop-up blocked" once on the phone: the tester tapped the pop-out control in a headless browser, and the notice is correct.

## Left as they are

- Hover-only tooltips can't be read on touch (the whole app; design call).
- "gem" in routine names ("Aico gem databases to CT 160" beside "Aico databases to CT 160"), "the other full Aico", and machine "aico" vs Aico agent vs project Aico.
- Files: Find narrows only the top level, not expanded folders. Download gives no sign beyond the browser's own.
- New session vs New chat side by side, with nothing saying how they differ.
- Pi stays selectable when used up, since it can run on another provider.
- Reminder field says nothing about when or how it fires.
- Recent has no way past 100 except search. "Aico agent chats are not searchable yet" wording. "oldest 59 min, late after 2 h" on Backups.

## For the next round

- A tester saw a real Aico session title about the owner's family, and a real file name in the home folder; neither was opened. lib.cjs now masks such titles and RULES.md limits Files to test folders.
