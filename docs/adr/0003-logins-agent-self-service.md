# ADR 0003: Saved site logins are agent self-service, except the username and password

- Status: accepted (owner decisions, 2026-11-07 and 2026-11-08: site logins only; agents may move a login page to another site, logged; who does what, settled 2026-11-08).
- Context: a Canvas login the owner saved on the Logins page was invisible to the agent that needed it (`aico logins list` dropped it), the refusal did not say what was missing, and every fix (machine, role, session, login page) was owner-only. The owner was sent back to the page three times for one login.

## The rule (owner, 2026-11-08)

1. **Owner:** saves usernames and passwords, removes logins, owns API, backup and tool keys.
2. **Agents and coordinators:** fix everything else on a saved site login without asking, logged.
3. **Coordinators and hunter coordinators:** give hunters test (lab) logins without asking. A hunter coordinator is work role `coordinator` (`coordinatorRoles` in `packages/fleet/data/logins-policy.json`) or a session Tether lists as a coordinator, which is what the session that starts a hunt usually is. A restricted role never counts as one, whatever Tether lists.
4. **Hunters (restricted roles):** use test logins for their assigned sites. A missing one is asked of their coordinator, never the owner; refusals say so.
5. **The owner's real accounts (`lab.kind` `account`):** closed to restricted roles at the moment of use, in one check (`LoginStore.gaps`), unless the owner marked that login "hunters OK" on the Logins page. The mark opens the account to use, never to change, and a coordinator still has to give it: an assignment on an "All roles" login, or a named role. Naming a restricted role on an unmarked account is refused like `allow`. Because the check is at use, a rename or an assignment can't hand an account over, so neither is refused or needs approval. Only the owner sets or clears the mark, logged; the page and `aico logins hunters-ok NAME on|off` are its doors, and the store refuses every other caller.
6. **Asking the owner:** only for a wrong or missing username or password, or a key that doesn't exist yet.

## Decision

- Once the owner has saved a site login's (account or lab login's) username and password, any agent fixes everything else itself, applied at once, with no ask, tap or wait:
  - who may use it: machines, roles, its own session (`aico logins allow NAME` gives the caller whatever is missing; `--role`, `--machine`, `grant` and `revoke` for others);
  - notes, the login page (any site, or the first one of an account that has none, with the old and new page shown in its activity), and an account or lab login's site name (`aico logins edit NAME`).
- Each change is recorded in the login's activity with who made it and what changed (never a value), and the Logins page shows it under the login and in Recent activity, so the owner can see or undo it.
- Only a wrong or missing username or password, or a key that doesn't exist yet, goes to the owner, as one plain `tether ask create`.
- `aico logins list` shows agents every login (restricted roles: only the logins they can be given); the ones they cannot use yet carry what is missing (machine, role or session) and the one command that fixes it. Refusals say the same.
- "All roles" opens an account login for unrestricted roles; synthetic and temporary lab logins still open only for a named role or an assigned session.

## Limits kept on purpose

- Everything else in the store (backup keys, API keys, passwords, tool logins) stays the owner's on the Logins page: who may use it and its notes and kind. An agent's `allow`, `grant`, `revoke`, `edit`, `set` or `rotate` on one is refused, and `aico logins list` says so. A saved key with the same name as a site login doesn't hide the site login from an agent. The one exception is a tool's own grant (`toolGrants` in `packages/fleet/data/logins-policy.json`): `st cloudflare` saves and refreshes its OAuth grant itself, logged, for any unrestricted caller.
- The login page probe only suggests pages on the saved site; it moves to another site only when someone sets that page.
- Opening a login to another session (it may be a hunter's), `aico logins assign` and naming a restricted role on a login stay with a coordinator (rule 3) or the owner.
- Restricted roles (`restrictedRoles` in `packages/fleet/data/logins-policy.json`: hunting, recon, verification) don't reach the owner's keys, reach a real account only under rule 5, and get test logins from a coordinator, not by themselves.
- Removing a login and setting the username or password stay the owner's: an agent's `set`, `rotate` or `lab refresh` can't save a new account login or change a saved one's username, password or login page (its other fields stay the agent's to fix). Values never appear in activity, logs or command output.
- `aico logins lab run` hands a login's values only to the shared adapters (`labPrograms` in `packages/fleet/data/logins-policy.json`: `st browser login` and its API read, deployed release and checkout) and to the programs that login declares (`aico logins edit NAME --program PATH`). `PYTHON -I SCRIPT` counts as SCRIPT; paths compare by real path when used, so a release's `current` link follows deploys. An interpreter or shell (`labInterpreters`) is never a program: it would run anything. Any other child is refused with the command that allows it. Adding or dropping a program is self-service like the rest (logged; restricted roles ask a coordinator), and each use records which program got the values.
