# Real-user round 8: last regression check on everything new since round 6

Haiku testers at 390 and 1440 wide, given a goal and evidence/user-test-8/RULES.md. lib.cjs stubs Needs you, approvals, logins, shares and grant history, makes every session and history title up, keeps live sessions from connecting and shows Files only /srv/scratch/zz-test-files. Findings were checked live before any change.

## Done in this round

| Area | Change |
|---|---|
| Tooltips | A title shows on a tap (a badge) or a hold (anything a tap acts on), checked with a real long press on Chromium: tip shows, no click, next touch closes it. The session's keys and Android's text selection are left alone |
| Routines | Names say Standby instead of "gem" and "the other full Aico" |
| Routines | A clock change skipping a set time says so: "no run Mar 14: the clock change skips 02:30" for a timer, "the clock change skips 02:30" for a built-in job on the new clock; the jump doesn't count as random delay |
| Machines | The machine `aico` is the Standby in Machines, session badges, Routines, power questions and shares. Its badge says Ready or Behind |
| Files | Find narrows open folders and keeps them open; a folder found by name shows all of it |
| Files | A preview closes with its X or a second tap on the file |
| Launcher | A bundle rebuilds from its package.json's real dependencies, so a change in fleet or shared isn't missed |

## Regressions

None.

## Not defects

- "Answer did not stick" on desktop: the helper's questions live per browser, and the tester's later script opened a new one. In one browser the answer stays answered.
- "Type an item above" is right: the field is above the line.
- Machines "runs past the sidebar": the wheel scrolls it (500 px measured).
- "readme.md still showing during a find": rows narrow once the find's short pause is over (about 0.4 s).
- "No notes yet" under Groceries, and "add" in login activity: the helper's.
- "Weekly container trim" last run Saturday: not the timer, whose next run is Monday. The run came minutes after the timer moved into the registry that evening, so most likely a hand run; not confirmed.
- A hold on "Hide team" hitting the list behind it: a real long press shows the tip and clicks nothing.

## Left as they are

- Standby's tooltip quotes Status rows word for word, a raw path included ("Standby checkout: dadbot: /srv/...").
- A routine's detail shows its command ("POST /api/export/notes").
- The page header says "Note" over a saved list (the Note/List switch just below says which). NotesView doesn't know the note's kind, so it isn't worth plumbing through for this.
- Group names that are machine names ("restic-append"), and "neri-hunt..." cut short in New session.

## For the next round

- A tester opened Settings > Grants and saw a real grant's description (a Cloudflare setup, "family-only sign-in"). lib.cjs now empties grant history. Project names under Quiet projects stay real.
