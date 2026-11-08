# Aico
Aico is a Linux companion for people working with terminal AI tools. Agent sessions keep running in the background and open in a browser or on the phone, owned by Tether, the session daemon. It also runs the owner's status, backups, notes and project tooling.

## Now
- Confirm the nightly GitHub publication runs clean and the morning digest reaches the phone (Nov 8)
## Next
- Failover: left is letting jobs held by the standby (note-reminders, morning digest) run on the workstation while the standby is down: a fallback must be opt-in per job, fire only on a connection error (not a refusal or pause) and sync its result back; jobs that need workstation data or credentials (nightly, publish, backups, usage) stay workstation-only. Done: repo copies, context copy, working checkouts of the active repos registered on the standby, morning digest on either host (docs/deployment.md)
- Power-off test and remote power control: on hold until the owner picks it up (plugs, `aico plug` and the open choices in docs/power-off-test.md)
## Later
- `st commit --paths FILE` after `git rm --cached FILE` (file kept on disk) adds it back instead of untracking it: `git commit --only` takes the path from the working tree, so untracking needs its own index step
