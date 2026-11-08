# Aico
Aico is a Linux companion for people working with terminal AI tools. Agent sessions keep running in the background and open in a browser or on the phone, owned by Tether, the session daemon. It also runs the owner's status, backups, notes and project tooling.

## Now
- Notifications leftovers: home alarm, update ready and phone pairing can't get a Settings switch until the next Android release; the Proxmox sender's own alarms (when no Aico answers) reach the phone but aren't on the shared list
## Next
- After the Drive (03:49) and housekeeping (05:15) runs on Nov 9: check the 44 failed Drive rows cleared, the restic caches are in `~/.cache/aico/backups` and `/var/tmp/aico-backups/cache-root`, and the journal shows `doing ...` lines
- Systems review leftovers (risk list: /srv/scratch/briefs/usage-burn-2026-11-08/lane10-final.md): recurring Status rows with no next_run can't go late; PVE packages, kernels, hand-installed Node and tools get no automatic updates; VM 100 runs Node 20 (past end of life); thin pool can't grow itself
- Sessions shift between Aico machines: always know what was going on, then a planned move to the standby (plan: docs/plans/session-shift/plan.md)
- After Claude Max ends (about 2:20 PM EST, Nov 8): check live that `st models route` and `aico usage show` say no plan, `st aico create --tool claude-code` refuses, the new-session dialog opens on another tool, and Status and the phone stay quiet. When the Codex subscription lapses, set its `effective_to` in usage-plans.json (owner said it goes off too, no date given)
- Test flake risks not yet seen failing (lane 15 runners-up, /srv/scratch/briefs/usage-burn-2026-11-08/lane15-report.md): checks fixture picks a free port then gives it to docker (`-p 127.0.0.1::5432` plus `docker port` removes the race); real-time limits in chat.test, fleet-leases and control.live; no suite-wide run yet with the clock moved ahead, wait until the delete guard is settled

## Later
