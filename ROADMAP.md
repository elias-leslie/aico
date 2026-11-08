# Aico
Aico is a Linux companion for people working with terminal AI tools. Agent sessions keep running in the background and open in a browser or on the phone, owned by Tether, the session daemon. It also runs the owner's status, backups, notes and project tooling.

## Now
- Confirm the nightly GitHub publication runs clean and the morning digest reaches the phone (Nov 8)
## Next
- Power-off test and remote power control: on hold until the owner picks it up (plugs, `aico plug` and the open choices in docs/power-off-test.md)
## Later
- User-test round 2 leftovers (Nov 8, evidence/user-test-5/findings.md): System badge counts say "notes" in one place and "problems" in another; routine rows mix last and next run times; "Check Portfolio" routine name is vague; quota "1 used up" wording; routine logs show node's SQLite ExperimentalWarning lines; a kept wake's relaunch treats a failed observe as "nobody holds the conversation" (Reopen refuses in that case); 127 MB of untracked evidence screenshots keep the aico repo copy over its 100 MB limit (decide: ignore evidence images or keep them in /srv/scratch)
- Logins leftovers (Nov 8 user test): every save shows "Saved here. An offline machine will sync when it reconnects." while any fleet peer is stopped, and it stays on screen until reload (name the machine, clear it on the next action); phone settings tabs are icons only; `lab run` hands values to any absolute child a session names (ADR 0003 limits)
