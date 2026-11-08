# Aico
Aico is a Linux companion for people working with terminal AI tools. Agent sessions keep running in the background and open in a browser or on the phone, owned by Tether, the session daemon. It also runs the owner's status, backups, notes and project tooling.

## Now
- Confirm the nightly GitHub publication runs clean and the morning digest reaches the phone (Nov 8)
## Next
- Failover: done are the repo copies on the standby (`aico wip`, bare mirrors) and its read-only copy of memories, prompts, roles and launch policy (`context-sync`, every 5 min); left are working checkouts of the active repos on the standby and letting more jobs take over when their home is down (today only note-reminders and the `--hosts either` routines can)
- Power-off test and remote power control: on hold until the owner picks it up (plugs, `aico plug` and the open choices in docs/power-off-test.md)
## Later
