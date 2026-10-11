# Tether API v1

Tether serves one versioned HTTP/1.1 API per instance over a private Unix socket. It is never network-exposed.

| Instance | Socket |
| --- | --- |
| any | `$XDG_RUNTIME_DIR/tether/<instance>/control.sock` (directory 0700, socket 0600) |
| `default` only, after Phase 3 | also `/run/user/<uid>/aico/control.sock` (legacy owner contract) and `/run/user/<uid>/aico/gui-control.sock` (legacy GUI shim); see [compat-contract.md](compat-contract.md) |

The socket's file permissions are the only authentication: any process running as the same uid may call the API. Apps that put Tether behind their own HTTP surface keep their own auth in front of it. A-Term in particular must never treat loopback as authenticated, because proxied traffic arrives from loopback.

Status: Phase 2 implements health, version, projects, agent tools and events. Every other route below is registered and answers `501 not_implemented` (marked `TODO(phase3)` in `src/server.ts`) until Phase 3 extracts Aico's lifecycle.

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
  "projectRoot": "/srv/workspaces/projects/aico",
  "origin": "aico",
  "aTermSessionId": null,
  "rootRequestId": null,
  "lifecycleVersion": 1,
  "tmux": {
    "serverId": "06e633492f792ad10439f675491801ee",
    "socket": "/home/u/.local/state/aico/tmux/06e6.../server.sock",
    "sessionId": "$3",
    "paneId": "%7",
    "sessionName": "aico-05e96622"
  },
  "createdAt": 1791686790237
}
```

`status` is one of:

- `running`: launch dispatched and an active managed workload verified.
- `pending`: reserved, never allocated.
- `uncertain`: allocated, but an active workload is not verified.
- `legacy`: a lifecycle-v0 session, kept read-only.

`available` is true only for `running`. An ended session is not listed; `GET` on it returns 404. A root keeps its ended tombstone under `/v1/roots`.

## Sessions

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/sessions` | none; query `project`, `origin`, `tool` | `{items: Descriptor[]}` from the catalog, with status from the last reconciliation |
| `POST /v1/sessions` | `{tool?, projectId?, projectRoot?, name?, origin, aTermSessionId?, size: {cols, rows}}` | `201` running or `202` pending/uncertain descriptor |
| `GET /v1/sessions/:id` | none | live-verified descriptor. Rechecks the generation after the async verification and returns `409 identity_changed` if it moved. |
| `PATCH /v1/sessions/:id` | `{generation, name}` | rename. `name: null` clears to the default label. The label follows the root title rules (trimmed, 1–160 UTF-8 bytes, no control characters). |
| `POST /v1/sessions/:id/end` | `{generation}` | `200 {status:"ended"}`. Exact containment retirement: stops only the owned pane scope and uses `cgroup.kill` fallback. |
| `POST /v1/sessions/:id/respawn` | `{generation}` | Replaces the pane workload with the session's stored tool. Returns the new descriptor and generation. A lifecycle-v0 session is refused with `409 legacy_session`. |
| `POST /v1/sessions/:id/load-tui` | `{generation, tool}` | Respawns with another tool and stores it on success |
| `POST /v1/sessions/:id/switch-project` | `{generation, projectId}` | Resolves the project root once, respawns there with the same tool, and stores `projectId`/`projectRoot` |
| `GET /v1/sessions/:id/diagnostics` | none | Content-free containment diagnostics (Aico's Session diagnostics): server, scope, invocation and cgroup identities |

The default tool applies when `tool` is omitted (see [Agent tools](#agent-tools)). A tool alias such as `claude` resolves to its canonical slug, which is what gets stored.

`size` is required on create because Aico creates the tmux session at the first view's grid size. A created session is never silently re-created. Once a session has ended, starting work again is an explicit new `POST`.

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
| `GET /v1/sessions/:id/attach` | none | `{generation, argv: ["/usr/bin/tmux","-S","<socket>","attach-session","-t","$3"], env: {TERM, COLORTERM, ...}}`. `argv` is the exact client argv. `env` is the client environment with `TMUX`/`TMUX_PANE`/`NO_COLOR` removed. |
| `GET /v1/sessions/:id/capture` | query `escapes=1` | `{generation, text}`: the visible screen |
| `GET /v1/sessions/:id/scrollback` | query `page`, `fromLine`, `escapes=1` | `{generation, page, pageCount, firstLine, lastLine, text}`. Bounded pages over the 200 000-line history (Aico `scrollback-page.ts`). |
| `POST /v1/sessions/:id/inject` | `{generation, text, mode: "type" \| "paste", submit?: bool}` | `{generation, delivered: true}` |

`mode: "type"` sends `send-keys -l`. `mode: "paste"` sends one bracketed-paste event; with `submit: true` it is followed by one Enter. Text must pass Aico's `isBoundedTerminalText` rule: nonblank, at most 2000 UTF-8 bytes, and no control characters except tab and newline. Injection is framing only. A `delivered` result does not mean the agent accepted the text, and it does not rule out a concurrent human draft. Injection is refused for non-`running` sessions.

### Active-client resize claim

When a view becomes active, it claims the shared tmux window size:

`POST /v1/sessions/:id/resize-claim` with body `{generation, clientPid, cols, rows}` returns `200 {applied: true}` or `{applied: false, reason}`.

Tether resizes only the window of the attached tmux client whose `client_pid` is `clientPid`. It refuses if that client is not attached exactly once, if the window is linked, or if the session has a status row (Aico `activateTmuxViewSize`). A successful claim publishes `session.resized`. Desktop auto-resize on active-client change is intended behavior. A-Term claims only when its view becomes active, not on every resize.

## Roots

A root is a session created through the root contract with a stable caller `requestId`. This is Aico's [root contract](https://github.com/elias-leslie/aico/blob/main/docs/root-control.md), moved unchanged, including the digest, tombstones, the resume adapter and every validation rule. Mutations serialize on the session identity and share one handler with the widget routes.

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/roots` | none | `{owner:"aico", available, directedDelivery, roots: Descriptor[]}` |
| `POST /v1/roots` | `{requestId, tool, projectId, projectRoot, initialPrompt, role, leadRootReference?, facetCapsuleRef?, resumeSessionId?}` | Existing or reserved root descriptor. `200` for running or ended, `202` for pending or uncertain. `409 request_conflict` if the same key arrives with a different digest. |
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

The root descriptor keeps Aico's fields: `owner: "aico"`, `hostIdentity`, `generation`, `logicalSessionId`, `surfaceLocator`, metadata, bounds and `status`. `owner` stays `"aico"` for compatibility with `st aico` and SummitFlow fleet.

Generation fencing:

- Every mutation requires the exact current generation and a `running` workload.
- A stale generation returns `409 stale_generation`.
- `pending`, `uncertain` or `legacy` returns `409 workload_unavailable`.
- If the session retires while the request waits, the response is `410 ended`.
- A root that has ended returns `410 ended`. Its tombstone means the same `requestId` can never start new work.

### GUI view-mutation forwarding

Show, position and title change views, and views belong to the app. Tether forwards them to one connected Aico GUI client:

1. The Aico GUI opens `GET /v1/gui/channel` with header `x-tether-client: aico-gui`. This is a long-lived NDJSON stream of `{commandId, kind, sessionId, generation, bounds?, label?}`. Only one GUI channel is active per instance. A second one replaces the first, which receives `{type:"superseded"}` and is closed.
2. For each command, the GUI verifies and applies the change (Aico `widgetMutationOperation`). It then posts `POST /v1/gui/results/:commandId` with `{applied: true}` or `{applied: false, error}`.
3. Tether answers the original caller with the GUI's result. A command that gets no result within 5 s answers `409 outcome_uncertain`.

With no GUI connected, these routes return `503 gui_unavailable` and nothing is applied. Tether never starts the desktop. `title` still renames the catalog entry only when the GUI applies it, so the result stays atomic. `GET /v1/health` reports `gui.connected`, and the events `gui.connected` / `gui.disconnected` announce changes.

## Agent tools

This is the merged registry. Editing it from either app changes launches in both.

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/tools` | query `enabled=1` | `{items: Tool[], defaultSlug}` |
| `GET /v1/tools/:ref` | none | A tool by id, slug or alias |
| `POST /v1/tools` | `{slug, name, argv \| command, processName?, description?, color?, displayOrder?, isDefault?, enabled?, aliases?, contextHook?}` | `201` with the tool |
| `PATCH /v1/tools/:ref` | any field except `slug` | The updated tool. `400 slug_immutable` if `slug` is sent. |
| `DELETE /v1/tools/:ref` | none | `{deleted: true}`. `409 default_tool` for the default tool; `409 tool_in_use` while a catalogued session runs it. |

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

`GET /v1/projects` (query `refresh=1` bypasses the cache) returns `{source, fetchedAt, projects: [{id, name, root, lifecycle}]}`.

`source` is one of:

- `summitflow`: from SummitFlow's `GET http://127.0.0.1:8001/api/projects` over loopback with no token, cached for 30 s. Archived projects are excluded.
- `summitflow-cache`: SummitFlow is unreachable, so the last good answer is served.
- `local`: SummitFlow is not installed or not reachable and there is no cache. The list comes from `~/.config/tether/projects.json`, a list of `{id, name?, root}`; entries whose roots are not directories are skipped.

`TETHER_SUMMITFLOW_URL` overrides the URL. Set it to `off` to disable SummitFlow.

## Events

`GET /v1/events?since=<seq>&bootId=<id>` streams NDJSON (`application/x-ndjson`), one event per line:

```json
{"seq": 12, "bootId": "uuid", "type": "session.updated", "at": 1791686790237, "data": {"id": "05e96622", "generation": "..."}}
```

How the stream works:

- It starts with `hello` (`data: {apiVersion, instance}`).
- With `since` and the same `bootId`, missed events are replayed from a 1024-event buffer. If they are no longer buffered, or the daemon restarted (different `bootId`), the stream sends `gap` and the client must re-list.
- `heartbeat` arrives every 15 s.
- `seq` restarts at 0 for each `bootId`. `hello`, `gap` and `heartbeat` carry the current `seq` and are not replayed.

Event types:

- `session.created`, `session.updated` (rename, respawn, tool or project change, status change), `session.ended`, `session.resized`
- `root.updated`
- `tools.changed` (`{slug|ref, change}`)
- `projects.changed`
- `gui.connected`, `gui.disconnected`

Events carry IDs and generations only, never terminal contents, prompts or titles.

SSE was rejected. NDJSON is simpler to consume from both Node and Python (`httpx` line streaming) over a Unix socket, and browsers never connect to Tether directly.

## Health and version

`GET /v1/health` never touches tmux. It returns:

```json
{"status":"ok","name":"tether","instance":"default","version":"0.0.1","apiVersion":1,"schemaVersion":1,
 "uptimeMs":966,"bootId":"uuid","eventSeq":0,"catalog":{"sessions":0,"tmuxServersActive":0,"rootRequests":0},
 "gui":{"connected":false},"lifecycle":"not_implemented"}
```

`lifecycle` becomes `"ready"` in Phase 3 once startup reconciliation finishes. Until then it is `"reconciling"`.

`GET /v1/version` returns `{name, version, apiVersion, minApiVersion, node}`.
