# Aico mockup 2: two canvases

Open `index.html` in a browser. Mockup only; nothing in the product changed.

## What a solo dev steering many agents needs, ranked

Frequency x urgency for one person running Claude Code, Codex, Pi and shells across the workstation, the Proxmox host, VMs and the phone.

| Need | How often | How urgent | Tier | Where |
|---|---|---|---|---|
| Which session is waiting on me, and answer it | many times an hour | high: agents stall | glance | top bar count, Needs you at the top of the pane, beacon dot on the session |
| Files the agent shared for the question | with each question | high | act | file chips open in place on the card (#28) |
| What each agent is doing: working, idle, finished | constantly | medium | glance | Sessions grouped Needs you / Working / Idle / Finished |
| The one thing that is broken worst | a few times a day | high when it is lost work | glance | Worst problem card with its fix (Resume) |
| Quota left vs time to reset | a few times a day | medium, high near the end of a window | glance | top bar mini bars, Quota bars with a "time gone" tick |
| Start a session | several times a day | medium | act | New session in the pane header |
| What happened while I was away | twice a day | medium | glance | one digest line, "See the day" timeline |
| All warnings, ranked by consequence | daily | medium | act | Status (Wide) |
| A project's roadmap and plan | daily | low | act | Projects (Wide), row opens Now / Next / Later |
| Past sessions and their final reply | daily | low | act | Recent (Wide) |
| Spend per day per provider | weekly | low | dig | Quota and spend |
| Backups age and restore | weekly | low until something fails | dig | Backups (Full) |
| Grants, logins, machines, recovery, settings | rarely | low, except a grant that's waiting | dig | Full; a waiting grant also shows in Needs you |
| Notes | ad hoc | low | detach | pops out to its own window (the existing app/notes) |

## The two canvases

- **Top bar: global state only.** The session on screen and its state (Live / Disconnected, working, who holds the size), the Needs you count, a health dot with the warning count, a quota glance. Each opens the right place in the pane in one click.
- **Left pane: what you have to work with.** Drag its edge; it snaps to four widths. Content reflows; the session never changes because you dragged.
- **Right pane: the session you type in.** Unchanged. Stays beside the pane until Full, where the pane covers it (Esc or the close button brings it back).

| Tier | Width | Shows |
|---|---|---|
| Rail | 64 px | icons and counts: Needs you, one mark per session with a state dot (the waiting one pulses), Status, Quota, Projects, Backups, Notes pop-out |
| Panel (default) | 360 px | since-you-looked line, Needs you cards, Sessions by state, Worst problem, Quota bars, "Everything else" list with a glance value on each |
| Wide | 58% | Panel plus a second column: Status ranked by consequence, Today timeline, Projects with roadmaps, Recent with final replies, Quota and spend |
| Full | 100% | dig: a side list (Status, Projects, Recent, Quota, Backups, Grants, Logins, Machines, Recovery, Notes, Settings) and the chosen one |

Keys (shown on the handle's tooltip): Alt+1 to Alt+4 jump to a tier, Alt+[ and Alt+] step, Esc back to Panel, double-click the handle for Panel. The pane header also has narrower/wider buttons.

**Phone (390 x 844):** the pane is a full-width slide-over on the session, opened from the menu button. Same content in one column; anything from "Everything else" opens in the sheet with a Back button.

**Charts, only where they answer faster:** quota used vs time gone in the window; the day's activity per session (asks and failures marked); spend per day per provider; backup age vs its limit per destination.

**Honest states:** the Server down toggle shows the offline top bar, "Can't reach Aico since 4:23 PM" with Retry, stale data dimmed and stamped "as of 4:23 PM", and the session as Disconnected.

## The 28 items, where they are

1 state groups and badges match Status · 2 server down · 3 Needs you card (plain meta, Not now apart, markdown rendered) · 4 masked secret in Notes · 5 quota wording · 6 roadmap Now/Next/Later, plan opens in place, empty state · 7 the Panel is the triage view · 8 phone reaches everything from the sheet · 9 one name each (Workstation, Proxmox host, Recent, Grants) · 10 Machines says which are session hosts · 11 Grants Waiting / History · 12 Backups summary and grouping · 13 Agents under Settings · 14 New session: name, last-used agent, no stray New chat · 15 phone header uses the width · 16 mode switch (not shown; unchanged from mockup 1) · 17 session rows carry state · 18 one frame, tokens from ui-kit · 19 44 px phone targets · 20 Status ranked by consequence, names not ids · 21-22 CLI (not in this mockup) · 23 since-you-looked line and Today · 24 spend per day · 25 Recent opens final reply and transcript · 26 Recovery with Resume · 27 carried over (not visual) · 28 file chips open in place.

## Screens

`shots/` has every tier on desktop (1440 x 900) and the phone sheet, the file viewer, New session, notes popped out, dragging with snap guides, the handle tooltip, and server down.
