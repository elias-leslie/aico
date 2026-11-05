# ST runtime cutover inventory

Every former core verb is routed below. Retained standalone extension manifests are in `packages/cli/data/extensions.json`; folded context, logins, status, elevate and web route to their Aico owners. No route uses the SF API.

| Old core verb | Destination |
| --- | --- |
| `create` | tasks |
| `list` | tasks |
| `ready` | dropped; use st list -s pending to inspect pending tasks |
| `ready-all` | dropped |
| `context` | tasks |
| `export` | dropped; use st tasks show ID for JSON |
| `cancel` | dropped; use st abandon ID |
| `pause` | dropped; use st tasks release ID --pause |
| `reopen` | dropped |
| `delete` | dropped |
| `update` | dropped; use st create --task ID --plan FILE for a plan update |
| `log` | tasks |
| `sync-progress` | dropped |
| `verify` | dropped |
| `critique` | dropped |
| `session-events` | dropped |
| `pulse` | tasks/status |
| `lease` | hook/Tether |
| `exec-log` | dropped |
| `check` | checks (full, quick, acceptance, focused tools and native stages) |
| `db` | CLI (read-only SQLite) |
| `claim` | tasks |
| `snap` | ops snapshots |
| `snaps` | ops snapshots |
| `recover` | dropped; use st snapshots restore for an isolated project |
| `rollback` | ops snapshots |
| `prune` | dropped |
| `done` | tasks/checks |
| `abandon` | tasks |
| `task` | tasks |
| `dep` | dropped |
| `test` | dropped |
| `subtask` | dropped; use st context ID, st claim 1.2 --task ID, or st done 1.2 --task ID |
| `claude` | dropped |
| `sessions` | hook handshakes + Tether history; niche old verbs dropped |
| `projects` | tasks registry |
| `git` | local Git |
| `vcs` | checks publish; hygiene repair dropped |
| `backup` | ops backups |
| `service` | ops Aico deploy + native service-tools for all projects |
| `runtime` | dropped |
| `logs` | ops journal |
| `monitor` | CLI /proc |
| `agent` | dropped; use aico agent run --role ROLE |
| `tools` | CLI manifest/extensions/admission |
| `cleanup` | dropped |
| `docker` | dropped |
| `setup` | dropped |
| `vm` | ops direct scoped PVE API |
| `checkpoints` | dropped |
| `autosnap` | dropped |
| `commit` | checks |

The former `tools catalog/status/adoption/audit/cost` reports used retired SF telemetry. Their retained subscription view is `aico usage show`; legacy adoption/audit reports are dropped. `tools manifest`, `tools extensions` and `tools run` are native CLI plumbing. `service observe` was SF server task-evidence reporting and is dropped.

Python service control is a direct compatibility port approved by the coordinator. It preserves project/unit/release contracts and delegates exact-commit acceptance to Aico; it does not carry a second checks engine. Its Python language preserves the local tool contract without a simultaneous deployment rewrite.
