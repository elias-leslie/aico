# ADR 0003: Saved logins are agent self-service, except the username and password

- Status: accepted (owner decision, 2026-11-07).
- Context: a Canvas login the owner saved on the Logins page was invisible to the agent that needed it (`aico logins list` dropped it), the refusal did not say what was missing, and every fix (machine, role, session, login page) was owner-only. The owner was sent back to the page three times for one login.

## Decision

- Once the owner has saved a login's username and password, any agent fixes everything else itself, applied at once, with no ask, tap or wait:
  - who may use it: machines, roles, its own session (`aico logins allow NAME` gives the caller whatever is missing; `--role`, `--machine`, `grant` and `revoke` for others);
  - notes, the login page (same site), and an account or lab login's site name (`aico logins edit NAME`).
- Each change is recorded in the login's activity with who made it and what changed (never a value), and the Logins page shows it under the login and in Recent activity, so the owner can see or undo it.
- Only a wrong or missing username or password goes to the owner, as one plain `tether ask create`.
- `aico logins list` shows agents every login; the ones they cannot use yet carry what is missing (machine, role or session) and the one command that fixes it. Refusals say the same.
- "All roles" opens an account login for unrestricted roles; synthetic and temporary lab logins still open only for a named role or an assigned session.

## Limits kept on purpose

- A login page on another site needs the owner (Edit on the Logins page): the saved password would otherwise be typed into a site the owner never chose. For the same reason an agent never sets the first login page of an account login, and the probe only suggests pages on the saved site.
- Opening a login to another session (it may be a hunter's) and `aico logins assign` stay with a coordinator or the owner.
- Restricted roles (`restrictedRoles` in `packages/fleet/data/logins-policy.json`: hunting, recon, verification) never reach the owner's own logins, get lab targets from a coordinator, not by themselves, and no other agent can name them on a login.
- Removing a login and setting the username or password stay the owner's. Values never appear in activity, logs or command output.
- `aico logins lab run` hands a login's values only to the shared adapters (`labPrograms` in `packages/fleet/data/logins-policy.json`: `st browser login` and its API read, deployed release and checkout) and to the programs that login declares (`aico logins edit NAME --program PATH`). `PYTHON -I SCRIPT` counts as SCRIPT; paths compare by real path when used, so a release's `current` link follows deploys. An interpreter or shell (`labInterpreters`) is never a program: it would run anything. Any other child is refused with the command that allows it. Adding or dropping a program is self-service like the rest (logged; restricted roles ask a coordinator), and each use records which program got the values.
