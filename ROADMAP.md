# Aico
Aico is a Linux companion for people working with terminal AI tools. Agent sessions keep running in the background and open in a browser or on the phone, owned by Tether, the session daemon. It also runs the owner's status, backups, notes and project tooling.

## Now
- Enroll VMs 200 and 201 (Aico fleet and OmniNull agent), CT 190 automatic updates, end the stuck dev test session
- Codebase cleanup: prune summitflow, agent-hub and nightshift and fold what is needed into Aico (plan: docs/plans/codebase-cleanup/plan.md)
- Projects page: runtime places, power actions and the page itself, then verify on phone and desktop (plan: docs/plans/projects-page/plan.md)
- Post-consolidation review: refresh the plan comparison, then Haiku 5.5 user testers and an Opus 5.5 user review of the owner's journeys; one recommendation list (design, UI, UX, usability, intuitiveness, solo-dev workflow across agents, projects and hosts) goes to the owner, and nothing changes until approved; then a measured performance and refactor run (plan: docs/plans/codebase-cleanup/cutlist.md)
## Next
- Split the session engine and move fleet code out of Tether
- Failover: copy active repos to the peer host and let jobs move when their home is down
- Power-off test with the owner once agent work is idle (both hosts, phone rescue and notes)
- Restore Neri hunter VM placement through Aico: VM 201 shows but the Proxmox authority (davion-gem) is not linked; keep the capacity safeguards, verify with a managed hunt dry run
## Later
- Multi-host Aico: install on gem (CT 190) and the agent VMs as one fleet (plan: docs/plans/codebase-cleanup/plan.md)
