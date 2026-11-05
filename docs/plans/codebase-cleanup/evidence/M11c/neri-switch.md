# Lab login switch

No Neri code, data or hunting session was opened or changed. Agent Hub's rows remain intact until its coordinator confirms the switch.

| Existing call | Aico call |
| --- | --- |
| `st agents credentials refs --target TARGET` | `st logins lab refs --target TARGET` |
| `st agents credentials enroll --target TARGET --actor ACTOR --kind synthetic --input FILE` | `st logins lab enroll --target TARGET --actor ACTOR --kind synthetic --input FILE` |
| `st agents credentials refresh --target TARGET --actor ACTOR --input FILE` | `st logins lab refresh --target TARGET --actor ACTOR --input FILE` |
| `st agents credentials run --target TARGET --request FILE -- /absolute/child ARGS` | `st logins lab run --target TARGET --request FILE -- /absolute/child ARGS` |

All these calls also work as `aico logins ...`. Enrollment and refresh accept private files or stdin (`--input -`); values never belong in arguments. `lab patch` accepts a private JSON document with `set`, `remove` and optional `expires_at` for partial changes. Account patches retain username/password and require the password again when the site changes.

A coordinator assigns targets before a hunter uses this area:

```
aico logins assign SESSION --target TARGET [--target ANOTHER_TARGET]
aico logins assignments
aico logins unassign SESSION
```

`SESSION` is the hunter's Aico session id, without `aico-widget-`. The caller recovers its own session and work role from the inherited context, including the nearest ancestor when the harness filters its child environment. A requested target alone grants nothing. A hunter can list, enroll, refresh, patch and use only assigned targets; it cannot retrieve provider/tool logins or backup keys. Coordinators can assign through the CLI; the owner can also change assignments on the page. There is no required owner step.

The request document remains a nonempty array of `{reference, fields, optional_fields?}` with `secret://lab/TARGET/ACTOR` references. Required fields must exist; absent optional fields are omitted. The trusted absolute child receives the same version-1 JSON document on descriptor 3, named by `AGENT_HUB_LAB_CREDENTIAL_FD`. Only PATH and the descriptor number reach its environment. Its stdin and output are disabled, as in Agent Hub's handoff. No secret is printed.

Full peers hold writable mirrors, resolve concurrent writes by entry revision (logical timestamp, then machine name), and retain deletion tombstones. Assignments and reveal activity replicate too. Workers receive granted entries and versioned revocations, forward writes through a dedicated authenticated Logins channel to a full peer, and use their saved read copies if no full peer is reachable. Worker callers keep their role and session; the link binds their machine and removes owner authority. Generic worker command execution remains refused.

Agent Hub's local implementation trusted the operator-supplied target; its storage comment described launch-derived scope as a future broker responsibility. Aico adds the explicit coordinator assignment binding. Do not switch an existing hunter until its session has the right assignment and its machine has the right grant. This is a deployment check for the coordinating agents, not an owner approval gate.

M10d-1 SDK handoff (2026-11-05): the standalone wheel now lives at `aico/native/st-sdk/dist/summitflow_st_sdk-0.2.1-py3-none-any.whl` (build: `uv build --directory native/st-sdk --wheel`, under `st tools run`). The Neri coordinator must install this wheel into Neri's own environment and refresh its dependency lock when switching. It preserves the `st_sdk` imports and version-1 extension context and uses Aico's project registry. M10d-1 deliberately did not open or alter Neri's repository, code, data, or environment; its existing SDK runtime and the bundled Neri registration remain in place until that coordinator performs the switch.
