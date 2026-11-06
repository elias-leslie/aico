# Aico
Aico is a Linux companion for people working with terminal AI tools. Agent sessions keep running in the background and open in a browser or on the phone, owned by Tether, the session daemon. It also runs the owner's status, backups, notes and project tooling.

## Now
- Retire Agent Hub: remove its leftover code from Aico and archive the repo
- Retire Nightshift: move what is still needed into Aico (host-change declarations, tray, boot and display helpers), drop the rest, archive the repo
- Enroll VMs 200 and 201 (Aico fleet and OmniNull agent), CT 190 automatic updates, end the stuck dev test session
- Projects page: phone fit of the project detail view; Cloudflare Access token check at the origin
- Codebase cleanup: prune summitflow, agent-hub and nightshift and fold what is needed into Aico (plan: docs/plans/codebase-cleanup/plan.md)
- Projects page: runtime places, power actions and the page itself, then verify on phone and desktop (plan: docs/plans/projects-page/plan.md)
## Next
- Split the session engine and move fleet code out of Tether
- Failover: copy active repos to the peer host and let jobs move when their home is down
- Power-off test with the owner once agent work is idle (both hosts, phone rescue and notes)
- Restore Neri hunter VM placement through Aico: VM 201 shows but the Proxmox authority (davion-gem) is not linked; keep the capacity safeguards, verify with a managed hunt dry run
## Later
- Multi-host Aico: install on gem (CT 190) and the agent VMs as one fleet (plan: docs/plans/codebase-cleanup/plan.md)
