# Real-user round 3: Status, Files, History, Notes, logins, grants, Needs you

Haiku testers at 390 and 1440 wide, given only the URL and a goal. Findings below were checked live by the coordinating agent before any change. Needs you ran against stubbed asks after two test asks reached the owner's list; both were withdrawn.

## Fixed

| Area | What the tester hit | Fix |
|---|---|---|
| Files | No way to find a name in a long folder | Find in this folder, narrowing the list by name |
| Files | Text and images could be opened but not saved | Download beside Open |
| History | A list stopped at 100 with no sign there were more | "Newest 100 ..." when the list stops at a full page |
| History | Filters missing at phone size, since the phone rule hid them for Status's sheet | Filters stay on a page without a sheet |
| History search | "so far" read as still searching | "newest first; older ones not searched" |
| Routines | "Next" gave a bare time that could be tomorrow | Later today is a time; tomorrow names the day |
| Routines | Long names cut off on the phone | Names wrap to two lines |
| Status | Backup ages read "120 h" | One span wording: minutes, hours, days |
| Status | Restore drill's name hid that it checks daily | "Aico restore drill: checks daily, runs monthly" |
| Ages | Session rows, Needs you, notes sync, tray and phone app rounded differently from Status | One shared formatter; the tray matches |
| Notes | Delete warning didn't say what happens to photos | Says items go and photos stay in Captures |
| Logins | Activity showed raw names like `_lab_school--default` and `rotate` | Shown name, "added", "password changed" |
| Logins | "Same access as" couldn't tell apart several logins on one site | Adds the username |
| Needs you | "Add 1 more photo" with none added | "Add a photo", "Add 2 photos" |
| Needs you | Words typed on a files question were lost on Not now | Not now takes them along |
| Needs you | Sent line doubled the stop after a sentence | Only adds a stop when none is there |
| Needs you | "No session will get the answer" read as a failure | "The agent reads this when it checks" |
| Needs you | Answered card said the agent acted, which isn't known | "Closed." with the time in a tooltip |
| Needs you | Urgency chip and approval step unexplained | Tooltips |
| New session | Nothing beside an agent said its subscription was out (redundancy audit item) | "73% left", "on credits", "used up"; nothing when not known |

## Not defects

- Counts changing between looks: real data, other agents were working. Same for 302 and 308 OK.
- "Sort is missing" on Status: it's there; on the phone behind Filters and sort.
- A VM ask next to "All current" on Backups: not a registered source yet, and another agent's ask.
- Standby row with no "Reported": it is a link row; the Standby badge covers it.
- Two routines with the same name: one per machine.
- Phone drop saving to `~/aico-uploads`: the toast names the path.
- Files × on Shared, disabled Send contrast, Copied feedback: already have a tooltip or the shared style.
- "1 vs 5 questions" on Needs you: caused by the test's own stub, not the app.
- Send stays closed on a files question with only a note: deliberate, the agent asked for files. Not now is the decline.

## Left as is

- Host-steward's status text has commands in its next-step lines across the catalogue. Tests assert them and agents use them; rewording is its own change.
- Portfolio's "Check Portfolio" wording belongs to that app.
- Files is a read-only browser: no upload into a folder and no delete. Capture is the upload path.
- Workstation probes warns on local agent Chrome, and testers' headless browsers add to it. It is how that row is meant to work.
