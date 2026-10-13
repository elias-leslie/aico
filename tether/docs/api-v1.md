# Tether API v1

Tether serves one versioned HTTP/1.1 API per instance over a private Unix socket. It is never network-exposed.

| Instance | Socket |
| --- | --- |
| any | `$XDG_RUNTIME_DIR/tether/<instance>/control.sock` (directory 0700, socket 0600) |
| `default` only | also `/run/user/<uid>/aico/control.sock` (legacy owner contract) and `/run/user/<uid>/aico/gui-control.sock` (legacy GUI shim); see [compat-contract.md](compat-contract.md) |

The socket's file permissions are the only authentication: any process running as the same uid may call the API. Apps that put Tether behind their own HTTP surface keep their own auth in front of it. A-Term in particular must never treat loopback as authenticated, because proxied traffic arrives from loopback.

Status: every route below is implemented (Phase 3a). Additions made for A-Term during 3a are additive v1 changes and are marked *(3a)*. Additions made after the live cutover are marked *(post-cutover)*. Schema version 3.

## Conventions

- Bodies are JSON (`content-type: application/json`, at most 128 KiB) and must be objects. Unknown fields are rejected with `400 invalid_body`, never ignored. Field names are camelCase.
- Errors are `{"error": "<code>", ...}` and the codes are stable API. A 4xx or 503 means nothing was applied. A 2xx or `409 outcome_uncertain` may have applied.
- No route retries anything on the caller's behalf. Clients must not retry an uncertain mutation with a different identity.
- Versioning: `apiVersion` is an integer. v1 only grows additively: new routes, new optional request fields, new response fields, new event types. Clients ignore unknown response fields and event types. A breaking change ships as `/v2` next to `/v1`. Apps declare the minimum `apiVersion` they need and compare it with `GET /v1/version`.
- Times are Unix epoch milliseconds.

## Identity

| Field | Format | Meaning |
| --- | --- | --- |
| `id` | 8 lowercase hex | Session ID. It equals Aico's widget ID and `AICO_WIDGET_ID` in the pane. It is never reused, even after End. |
| `ownershipId` | string | Stable ownership ID (`AICO_SESSION_ID`, usually `aico-widget-<id>`). |
| `generation` | 64 lowercase hex | Opaque SHA-256 fence over the session's exact identity. It is byte-compatible with Aico's `sessionGeneration`. Every mutation names the generation it read. A different generation means a different workload: re-read, never retry blindly. |
| `requestId` | `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` | Caller key for a root. It survives End as a tombstone. |

## Session descriptor

```json
{
  "id": "05e96622",
  "ownershipId": "aico-widget-05e96622",
  "generation": "<64 hex>",
  "status": "running",
  "available": true,
  "tool": "claude-code",
  "name": null,
  "label": "Session 3",
  "projectId": "aico",
  "projectRoot": "/home/demo/projects/aico",
  "origin": "aico",
  "aTermSessionId": null,
  "coordinator": false,
  "coordinatorId": "d2852144",
  "coordinatorColor": "#6fa8ff",
  "rootRequestId": null,
  "lifecycleVersion": 1,
  "tmux": {
    "serverId": "06e633492f792ad10439f675491801ee",
    "socket": "/home/u/.local/state/aico/tmux/06e6.../server.sock",
    "sessionId": "$3",
    "paneId": "%7",
    "sessionName": "aico-05e96622"
  },
  "contextHook": {
    "state": "available",
    "detail": "...",
    "tool": "claude-code",
    "applicable": true,
    "checkedAt": 1791686791000
  },
  "state": "blocked",
  "stateSource": "claude-status",
  "stateAt": 1791690000000,
  "stateDetail": "permission prompt",
  "statePrevious": "working",
  "createdAt": 1791686790237
}
```

`status` is one of:

- `running`: launch dispatched and an active managed workload verified.
- `pending`: reserved, never allocated.
- `uncertain`: allocated, but an active workload is not verified.
- `legacy`: a lifecycle-v0 session, kept read-only.

`origin` is `aico`, `a-term`, `cli` or `root` (created through `POST /v1/roots`).

`coordinator`, `coordinatorId` and `coordinatorColor`: see [Coordinators](#coordinators).

`available` is true only for `running`. An ended session is not listed; `GET` on it returns 404. A root keeps its ended tombstone under `/v1/roots`.

`contextHook` *(post-cutover)* is Tether's latest check of the tool's Agent Hub context hook (see [Agent tools](#agent-tools)). `state` is `available`, `missing`, `unsupported`, `not_applicable`, or `unknown` when no check for the session's current `tool` has finished yet. `applicable` is false for a tool with no context mechanism (the bare shell). Tether checks after every launch, respawn, tool load and project switch, after its own restart (running sessions, one at a time, in the background) and on `POST /v1/sessions/:id/context-check`. A changed result publishes `session.updated`. The check is an independent probe: it never blocks the native tool, and it does not claim what an already-running session received.

`state` is the agent's state: `working`, `idle`, `blocked` (waiting on the user: a permission prompt or a question) or `unknown` (no agent found, or the session is not running). `stateSource` names what said so (`claude-status`, `claude-hook`, `codex-rollout`, `none`), `stateAt` is when the state last changed (null while unknown), `stateDetail` says why it is blocked, and `statePrevious` is the state before (so `working` → `idle` is a finished turn, while `unknown` → `idle` is an agent Tether only just found). A change publishes `session.updated`. See [agent-state.md](agent-state.md).

## Sessions

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/sessions` | none; query `project`, `origin`, `tool` | `{items: Descriptor[]}` from the catalog, with status from the last verification. A session whose current generation has never been verified (a fresh root or replacement) is verified first, so the list agrees with `GET /v1/sessions/:id` *(post-cutover)*. |
| `POST /v1/sessions` | `{tool?, projectId?, projectRoot?, name?, origin, aTermSessionId?, size: {cols, rows}}` | `201` running or `202` pending/uncertain descriptor. A `202` also carries `failure: {code, reason} \| null` (`workload_unavailable`, `outcome_uncertain`). `origin` is `aico`, `a-term` or `cli`; `aTermSessionId` (a UUID) is accepted only with `a-term`. |
| `GET /v1/sessions/:id` | none | live-verified descriptor. Rechecks the generation after the async verification and returns `409 identity_changed` if it moved. |
| `PATCH /v1/sessions/:id` | `{generation, name}` | rename. `name: null` clears to the default label. The label follows the root title rules (trimmed, 1–160 UTF-8 bytes, no control characters). |
| `POST /v1/sessions/:id/end` | `{generation}` | `200 {status:"ended"}`. Exact containment retirement: stops only the owned pane scope and uses `cgroup.kill` fallback. |
| `POST /v1/sessions/:id/respawn` | `{generation}` | Replaces the pane workload with the session's stored tool. Returns the new descriptor and generation. A lifecycle-v0 session is refused with `409 legacy_session`. |
| `POST /v1/sessions/:id/load-tui` | `{generation, tool}` | Respawns with another tool and stores it on success |
| `POST /v1/sessions/:id/switch-project` | `{generation, projectId}` or `{generation, projectRoot}` *(post-cutover)* | With `projectId`: resolves the project root once, respawns there with the same tool, and stores `projectId`/`projectRoot`. With `projectRoot` (an absolute existing directory, as on create; Aico's Personal Workspace): respawns there and stores `projectId: null`. Exactly one of the two; a root that is not a directory is `400 unknown_project`. |
| `GET /v1/sessions/:id/diagnostics` | none | Content-free containment diagnostics (Aico's Session diagnostics): server, scope, invocation and cgroup identities, plus `agent: {state, stateSource, stateAt, stateDetail}` |
| `POST /v1/sessions/:id/context-check` *(post-cutover)* | none | Re-checks the context hook now and answers `{generation, contextHook}` |
| `POST /v1/sessions/:id/agent-event` | `{event, agent, notificationType?, agentSessionId?}` | An agent hook's report (`event`: `Notification`, `PermissionRequest`, `UserPromptSubmit`, `Stop`; `agent`: `claude` or `codex`). Answers `{applied, state, stateSource, stateAt, stateDetail}`; a report that says nothing about state, or comes from another conversation than the session's agent, has `applied: false`. |

The default tool applies when `tool` is omitted (see [Agent tools](#agent-tools)). A tool alias such as `claude` resolves to its canonical slug, which is what gets stored.

`size` is required on create because Aico creates the tmux session at the first view's grid size. A created session is never silently re-created. Once a session has ended, starting work again is an explicit new `POST`. A create refused before allocation (`admission_denied`, `linger_required`) leaves nothing in the catalog.

Every pane carries `AICO_OWNER=aico`, `AICO_WIDGET_ID`, `AICO_SESSION_ID`, `AICO_AGENT_SLUG`, `ST_SESSION_ID` and, for `origin: "a-term"` with an id, `A_TERM_SESSION_ID`. It never carries `AICO_TMUX_SOCKET`. tmux servers start from `env -i` plus an allow-list inside `systemd-run`, so the daemon's environment never leaks into panes.

Session IDs are never reused: an ended ID is kept in `retired_session_ids`.

Session errors:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_body`, `invalid_generation`, `unknown_tool`, `unknown_project` | The request is malformed or names something that does not exist |
| 404 | `not_found` | The session does not exist |
| 409 | `stale_generation` | The caller's generation is not the current one |
| 409 | `busy` | Another lifecycle operation holds the session |
| 409 | `blocked` | `reason` says why; for example, containment cleanup could not be proven |
| 409 | `workload_unavailable` | The session is not `running` |
| 409 | `admission_denied` | Agent admission refused: memory pressure or too many concurrent agents. The body includes `reason`. |
| 409 | `outcome_uncertain` | The request may have applied |
| 503 | `linger_required` | Linger is off. Durable work is refused. |
| 500 | `internal_error` | Unexpected failure |

## Terminal I/O

Apps keep their own byte path: a PTY that runs `tmux attach` against the session's private socket. Tether hands out the target. It never proxies terminal bytes.

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/sessions/:id/attach` | none | `{generation, argv: ["/usr/bin/tmux","-S","<socket>","attach-session","-t","$3"], env, unset}`. `argv` is the exact client argv. |
| `GET /v1/sessions/:id/capture` | query `escapes=1` | `{generation, text}`: the visible screen |
| `GET /v1/sessions/:id/scrollback` | query `fromLine`, `count` (at most 5000, default 5000), `escapes=1` | `{generation, fromLine, totalLines, historySize, text}`. One bounded page of pane history (Aico `scrollback-page.ts`); line `historySize + r` is visible row `r`. Without `fromLine`, the last page. `400 invalid_query` for a non-integer. |
| `POST /v1/sessions/:id/inject` | `{generation, text, mode: "type" \| "paste", submit?: bool}` | `{generation, delivered: true}` |
| `GET /v1/sessions/:id/pane-mode` *(post-cutover)* | none | `{generation, alternateScreen, mouseReporting, historySize, inMode, mode}`: whether the pane shows its alternate screen, whether the program asked for mouse reporting, the history line count, and whether tmux shows a mode over the pane (`mode` is its name, such as `copy-mode`, else null). Read-only `display-message`. `409 workload_unavailable` when tmux cannot answer. |

Attach `env` holds **overrides only**, not a full environment: set exactly `TERM=xterm-256color`, `COLORTERM=truecolor` and `CLICOLOR=1` over the client's own environment, then remove every key in `unset` (`TMUX`, `TMUX_PANE`, `TMUX_TMPDIR`, `NO_COLOR`). Both lists may grow additively.

`mode: "type"` sends `send-keys -l`. `mode: "paste"` sends one bracketed-paste event; with `submit: true` it is followed by one Enter. Text must pass Aico's `isBoundedTerminalText` rule: nonblank, at most 2000 UTF-8 bytes, and no control characters except tab and newline. Injection is framing only. A `delivered` result does not mean the agent accepted the text, and it does not rule out a concurrent human draft. Injection is refused for non-`running` sessions.

### Active-client resize claim

When a view becomes active, it claims the shared tmux window size:

`POST /v1/sessions/:id/resize-claim` with body `{generation, clientPid, cols, rows}` returns `200 {applied: true}` or `{applied: false, reason}`. A successful claim also moves the foreground pane's `MemoryLow=2G` to this session's pane scope, since Aico claims the size when a view gains focus.

`POST /v1/sessions/:id/show` with body `{generation}` asks the connected GUI to open or focus the session's view. It returns `200 {shown: true}`, `503 gui_unavailable` with no GUI connected, or `409` when the session is not running or the GUI rejected the command.

Tether resizes only the window of the attached tmux client whose `client_pid` is `clientPid` (Aico `activateTmuxViewSize`). `reason` is one of *(3a)*:

| Reason | Retry? | Meaning |
| --- | --- | --- |
| `client_not_attached` | yes | No tmux client with that pid is attached exactly once, or it detached or switched windows during the claim. Retry after the attach settles. |
| `stale` | yes | The generation changed during the claim. Re-read the session. |
| `tmux_unavailable` | yes | A tmux query failed (server going away). |
| `window_linked` | no | The client's window is linked into another session. |
| `status_row` | no | The session shows a tmux status row (`status` is not `off`, including the global value). |
| `invalid` | no | `clientPid`, `cols` or `rows` is not a positive integer. |

A stale or wrong-workload `generation` is refused before the claim with `409 stale_generation` / `409 workload_unavailable`. A successful claim publishes `session.resized`. Desktop auto-resize on active-client change is intended behavior. A-Term claims only when its view becomes active, not on every resize.

## Roots

A root is a session created through the root contract with a stable caller `requestId`. This is Aico's [root contract](https://github.com/elias-leslie/aico/blob/main/docs/root-control.md), moved unchanged, including the digest, tombstones, the resume adapter and every validation rule. Mutations serialize on the session identity and share one handler with the widget routes.

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/roots` | query `origin=aico\|a-term` *(3a)*, `ended=0\|1` *(post-cutover)* | `{owner, available, directedDelivery, roots: Descriptor[]}`. `owner` is the `origin` filter, else `"aico"`. `ended=0` leaves out ended tombstones (they stay readable at `GET /v1/roots/:requestId`); the legacy `gui-control.sock` accepts it too. `400 invalid_query` for another origin or `ended` value. |
| `POST /v1/roots` | `{requestId, tool, projectId, projectRoot, initialPrompt, role, leadRootReference?, facetCapsuleRef?, resumeSessionId?, origin?, aTermSessionId?, launchedBy?}` | Existing or reserved root descriptor. `200` for running or ended, `202` for pending or uncertain. `409 request_conflict` if the same key arrives with a different digest. |
| `GET /v1/roots/:requestId` | none | Current descriptor, including ended tombstones (`status: "ended"`, `generation: null`) |
| `POST /v1/roots/:requestId/show` | `{generation}` | Forwarded to the GUI |
| `POST /v1/roots/:requestId/position` | `{generation, bounds: {x, y, width, height}}` | Forwarded to the GUI |
| `POST /v1/roots/:requestId/title` | `{generation, label}` | Renames the session in Tether and forwards to the GUI |
| `POST /v1/roots/:requestId/end` | `{generation}` | Same as session End. The tombstone is retained. |
| `POST /v1/roots/:requestId/send` | none | `503 directed_delivery_unavailable` |
| `GET` and `POST /v1/roots/:requestId/admin` | as in Aico | Generation-checked, fail-closed `503`. No terminal input. |
| `GET /v1/widgets/:id` | none | Compact descriptor `{owner:"aico", widgetId, sessionId, generation, status, available}` |
| `POST /v1/widgets/:id/title` | `{generation, label}` | As for roots |
| `POST /v1/widgets/:id/position` | `{generation, bounds}` | As for roots |
| `POST /v1/widgets/:id/coordinator` | `{generation, coordinator: boolean}` | Marks or unmarks a coordinator in the catalog (see [Coordinators](#coordinators)) and forwards it to the GUI when one is connected |

The root descriptor keeps Aico's fields: `owner`, `hostIdentity`, `generation`, `logicalSessionId`, `surfaceLocator`, metadata, `bounds` and `status`. `bounds` is always `null` from Tether: window geometry belongs to the GUI.

Root origin *(3a)*: `origin` is `"aico"` (default) or `"a-term"`; `aTermSessionId` (a UUID) is accepted only with `"a-term"` and becomes the pane's `A_TERM_SESSION_ID`. Neither is part of the request digest. On `/v1`, a root's `owner` is its stored origin and the descriptor also carries `origin`. The legacy sockets on the default instance (`/run/user/<uid>/aico/control.sock` and `gui-control.sock`) keep Aico's wire format exactly: `owner: "aico"` and no `origin` field, so `st aico` and SummitFlow fleet are unaffected.

Root-request tombstones from Aico are imported by `tether import-aico`; there is no separate tombstone import route.

Generation fencing:

- Every mutation requires the exact current generation and a `running` workload.
- A stale generation returns `409 stale_generation`.
- `pending`, `uncertain` or `legacy` returns `409 workload_unavailable`.
- If the session retires while the request waits, the response is `410 ended`.
- A root that has ended returns `410 ended`. Its tombstone means the same `requestId` can never start new work.

### Coordinators

A coordinator is a session that launches and steers other sessions (lanes). The catalog is the one record of who coordinates whom; Aico and A-Term both draw it from the descriptor.

- `launchedBy` on `POST /v1/roots` names the session that asked for the root (`st aico create` sends its `AICO_WIDGET_ID`, from Aico or A-Term). It is not part of the digest and only counts when the root is first reserved. If the launcher belongs to a coordinator, the new root belongs to that same root coordinator, so a lane's helpers join the lane's coordinator. Otherwise the launcher becomes a coordinator and the root belongs to it. An unknown launcher records nothing.
- `coordinator` is true for a coordinator. `coordinatorId` is the root coordinator that launched this session, or null (always null for a coordinator). It stays set after that coordinator ends.
- `coordinatorColor` is the coordinator's colour, `#rrggbb` from a fixed palette of eight, on the coordinator and on each of its lanes. A new coordinator takes the first colour no other coordinator holds, so coordinators on screen together differ until there are more than eight. Lanes keep their colour after the coordinator ends.
- `POST /v1/widgets/:id/coordinator` marks or unmarks one by hand (`st aico widget coordinator on|off`), with or without a GUI connected, and publishes `session.updated`. Unmarking frees the colour; lanes keep theirs.

### GUI view-mutation forwarding

Show, position, title and coordinator change views, and views belong to the app. Tether forwards them to one connected Aico GUI client:

1. The Aico GUI opens `GET /v1/gui/channel` with header `x-tether-client: aico-gui`. This is a long-lived NDJSON stream of `{commandId, kind, sessionId, generation, bounds?, label?, coordinator?}`. Only one GUI channel is active per instance. A second one replaces the first, which receives `{type:"superseded"}` and is closed.
2. For each command, the GUI verifies and applies the change (Aico `widgetMutationOperation`). It then posts `POST /v1/gui/results/:commandId` with `{applied: true}` or `{applied: false, error}`.
3. Tether answers the original caller with the GUI's result. A command that gets no result within 5 s answers `409 outcome_uncertain`.

With no GUI connected, `show` and `position` return `503 gui_unavailable` and nothing is applied; Tether never starts the desktop. `coordinator` without a GUI changes only the catalog. `title` without a GUI *(3a)* renames the session in the catalog under the lifecycle lock, fenced on the exact running generation, and publishes `session.updated`. With a GUI connected, `title` renames the catalog entry only when the GUI applies it, so the result stays atomic. `GET /v1/health` reports `gui.connected`, and the events `gui.connected` / `gui.disconnected` announce changes.

## Agent tools

This is the merged registry. Editing it from either app changes launches in both.

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/tools` | query `enabled=1` | `{items: Tool[], defaultSlug}` |
| `GET /v1/tools/:ref` | none | A tool by id, slug or alias |
| `POST /v1/tools` | `{slug, name, argv \| command, processName?, description?, color?, displayOrder?, isDefault?, enabled?, aliases?, contextHook?}` | `201` with the tool |
| `PATCH /v1/tools/:ref` | any field except `slug` | The updated tool. `400 slug_immutable` if `slug` is sent. |
| `DELETE /v1/tools/:ref` | none | `{deleted: true}`. `409 default_tool` for the default tool; `409 tool_in_use` while a catalogued session runs it. |
| `POST /v1/tools/import` *(3a)* | `{tools: ToolInput[] (≤200), dryRun?, updateExisting?}` | `{applied, created: slug[], updated: slug[], unchanged: slug[], differs: [{slug, fields}]}`. One transaction: any invalid entry rejects the whole batch with `400` and nothing is written. Existing slugs are left alone and reported in `differs` unless `updateExisting` is true. `dryRun` reports the same result and rolls back. Publishes `tools.changed` when anything changed. |

```json
{
  "id": "uuid",
  "slug": "codex",
  "name": "Codex",
  "argv": ["codex", "--yolo"],
  "command": "codex --yolo",
  "processName": "codex",
  "description": "OpenAI Codex coding agent",
  "color": "#9B8CFF",
  "displayOrder": 1,
  "isDefault": true,
  "enabled": true,
  "aliases": [],
  "contextHook": "codex-hooks",
  "createdAt": 0,
  "updatedAt": 0
}
```

How tool fields work:

- `argv` is authoritative. `command` is accepted on input for A-Term compatibility. It is split on spaces and tabs, and only plain words are allowed: no quotes, `$`, globs, redirections or operators (`400 invalid_command`). On output, `command` is the shell-quoted rendering of `argv`.
- An empty `argv` is the bare shell.
- Setting `isDefault: true` atomically clears the previous default. If no enabled tool is marked default, the first enabled tool by `displayOrder` is used.
- Slugs and aliases share one namespace (`409`/`400 slug_conflict`).
- `contextHook` is one of `claude-session-start`, `codex-hooks`, `pi-extension` or `canonical-retrieval:antigravity`. Tether verifies it at launch (Aico `tui/context.ts`). A failed check stays visible but never blocks the native TUI.
- Resume adapters (Codex `resume --no-daemon <uuid>`) are code, not data. They are keyed by canonical slug and cannot be edited through this API.

Seeded tools, from the Aico TUI specs reconciled with A-Term's live rows:

| Slug | argv | Default | Notes |
| --- | --- | --- | --- |
| `claude-code` | `claude --dangerously-skip-permissions` | | Alias `claude` (A-Term's slug) |
| `codex` | `codex --yolo` | yes | Owner decision. Aico's tray default was `claude-code`. |
| `agy` | `agy --dangerously-skip-permissions` | | |
| `pi` | `pi --approve` | | Aico's flag. A-Term's bare `pi` showed Pi's project-trust prompt. |
| `shell` | (empty) | | Interactive login shell |

## Projects

`GET /v1/projects` (query `refresh=1` bypasses the cache) returns `{source, fetchedAt, activeProjectId, projects: [{id, name, root, lifecycle, current}]}`.

`activeProjectId` and `current` *(post-cutover)* name SummitFlow's persisted active project (`st projects active`), read from its pointer file `~/.local/share/st/active-project.json` on every request. It is null, and every `current` false, when the file is absent or malformed or names a project that is not listed. `TETHER_ACTIVE_PROJECT_FILE` overrides the path; `off` ignores it. Changing the pointer publishes no event.

`source` is one of:

- `summitflow`: from SummitFlow's `GET http://127.0.0.1:8001/api/projects` over loopback with no token, cached for 30 s. Archived projects are excluded.
- `summitflow-cache`: SummitFlow is unreachable, so the last good answer is served.
- `local`: SummitFlow is not installed or not reachable and there is no cache. The list comes from `~/.config/tether/projects.json`, a list of `{id, name?, root}`; entries whose roots are not directories are skipped.

`TETHER_SUMMITFLOW_URL` overrides the URL. Set it to `off` to disable SummitFlow. `refresh=1` re-reads `projects.json` in local mode.

`POST /v1/projects` *(3a)* with `{id, root, name?}` registers a project in local mode: it appends to `projects.json` atomically (temp file and rename, mode 0600), refreshes the list, returns `201 {id, name, root, lifecycle: null}` and publishes `projects.changed`. Errors: `400 invalid_project_id` (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`), `400 invalid_project_root` (not an absolute directory), `409 project_exists`, `409 local_projects_unreadable`, and `409 projects_managed_by_summitflow` when the source is SummitFlow (register the project there).

## Events

`GET /v1/events?since=<seq>&bootId=<id>` streams NDJSON (`application/x-ndjson`), one event per line:

```json
{"seq": 12, "bootId": "uuid", "type": "session.updated", "at": 1791686790237, "data": {"id": "05e96622", "generation": "...", "session": {"id": "05e96622", "...": "..."}}}
```

How the stream works:

- It starts with `hello` (`data: {apiVersion, instance}`).
- With `since` and the same `bootId`, missed events are replayed from a 1024-event buffer. If they are no longer buffered, or the daemon restarted (different `bootId`), the stream sends `gap` and the client must re-list.
- `heartbeat` arrives every 15 s.
- `seq` restarts at 0 for each `bootId`. `hello`, `gap` and `heartbeat` carry the current `seq` and are not replayed.

Event types:

- `session.created`, `session.updated` (rename, respawn, tool or project change, status change, context-hook result), `session.ended`, `session.resized`
- `root.updated`
- `tools.changed` (`{slug|ref, change}`)
- `projects.changed` (`{id, change: "registered"}`)
- `legacy.changed` *(post-cutover)*: `{names}`, the A-Term legacy session names now listed (see below)
- `gui.connected`, `gui.disconnected`

`session.created` and `session.updated` carry `session` *(post-cutover)*: the session descriptor as `GET /v1/sessions` would list it, with a status verified for the exact generation the event announces. Clients can apply it instead of fetching the descriptor; one that sees no `session` (an older Tether) re-reads. Session events are published in order through one queue. `session.ended` and `session.resized` carry the ID (and generation) only.

Events never carry terminal contents or prompts. A `session` snapshot carries the session's name and label, which every `GET /v1/sessions` caller on the same socket can read anyway.

SSE was rejected. NDJSON is simpler to consume from both Node and Python (`httpx` line streaming) over a Unix socket, and browsers never connect to Tether directly.

## A-Term legacy sessions

A-Term's pre-Tether sessions (`summitflow-<uuid>` on `/tmp/tmux-<uid>/default`) are listed for attach and end only. Tether never adopts that server, never respawns them, and never touches any other session on it.

Only the `default` instance reads that server *(post-cutover)*. Another instance (a test `dev`) lists none and cannot attach or end them, unless `TETHER_ATERM_LEGACY_SOCKET` names a server explicitly.

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/legacy-sessions` | none | `{items: [{kind: "legacy-attach-only", name, aTermSessionId, createdAt, attachedClients}]}`; empty when the server is not running |
| `GET /v1/legacy-sessions/:name/attach` | none | `{argv: [tmux, "-S", socket, "attach-session", "-t", "=<name>"], env, unset}` |
| `GET /v1/legacy-sessions/:name/pane-mode` *(post-cutover)* | none | The same pane-mode answer as for a session, without `generation`; `404 not_found` for a name that is not listed |
| `POST /v1/legacy-sessions/:name/end` | none | `{status: "ended"}` after `tmux kill-session -t =<name>` for an exactly listed name; `404 not_found` otherwise |

`legacy.changed` *(post-cutover)* announces a changed list with `{names}`. Tether compares each list it reads with the previous one: after its own End, on every `GET`, and from a 15 s poll that runs while legacy sessions exist. Nothing creates legacy sessions any more, so the poll stops for good once the list is empty. The first list after a daemon start is the baseline and is not announced; clients re-list on `hello`/`gap` as for sessions.

## Health and version

`GET /v1/health` never touches tmux. It returns:

```json
{"status":"ok","name":"tether","instance":"default","version":"0.1.0","apiVersion":1,"schemaVersion":3,
 "uptimeMs":966,"bootId":"uuid","eventSeq":0,"catalog":{"sessions":0,"tmuxServersActive":0,"rootRequests":0},
 "gui":{"connected":false},"lifecycle":"ready"}
```

`lifecycle` is `"reconciling"` until startup reconciliation finishes, then `"ready"`. It is `"disabled"` when the daemon runs with `TETHER_RECONCILE=off` (tests and catalog inspection): startup never observes, adopts or stops a tmux server and the pane-exit watcher is off. Use it only for tests and read-only inspection of a catalog.

`GET /v1/version` returns `{name, version, apiVersion, minApiVersion, node}`.
