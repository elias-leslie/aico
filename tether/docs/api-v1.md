# Tether API v1

Tether serves one versioned HTTP/1.1 API per instance over a private Unix socket. It is never network-exposed.

| Instance | Socket |
| --- | --- |
| any | `$XDG_RUNTIME_DIR/tether/<instance>/control.sock` (directory 0700, socket 0600) |

The socket's file permissions are the only authentication: any process running as the same uid may call the API. Apps that put Tether behind their own HTTP surface keep their own auth in front of it. The web app in particular must never treat loopback as authenticated, because proxied traffic arrives from loopback.

Status: every route below is implemented (Phase 3a). Additions made for the web app during 3a are additive v1 changes and are marked *(3a)*. Additions made after the live cutover are marked *(post-cutover)*. Schema version 10.

## Conventions

- Bodies are JSON (`content-type: application/json`, at most 128 KiB) and must be objects. Unknown fields are rejected with `400 invalid_body`, never ignored. Field names are camelCase.
- Errors are `{"error": "<code>", ...}` and the codes are stable API. A 4xx or 503 means nothing was applied. A 2xx or `409 outcome_uncertain` may have applied.
- No route retries anything on the caller's behalf. Clients must not retry an uncertain mutation with a different identity.
- Versioning: `apiVersion` is an integer. v1 only grows additively: new routes, new optional request fields, new response fields, new event types. Clients ignore unknown response fields and event types. A breaking change ships as `/v2` next to `/v1`. Apps declare the minimum `apiVersion` they need and compare it with `GET /v1/version`; an addition an app depends on (a request field an older Tether would refuse) raises `apiVersion`. 2 *(post-cutover)*: the resize claim's `viewer`. 3 *(post-cutover)*: session wakes and End's `keepWakes`. 4: shares link files where they are. 5: the Agent Hub chat routes ([Agent Hub sessions](#agent-hub-sessions)). 6: `inject` takes `model` for an Agent Hub session.
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
  "wakes": [{"id": "5f1c0a9b2e7d", "dueAt": 1791693000000, "note": "check the lane reports", "createdBy": "agent"}],
  "createdAt": 1791686790237
}
```

`status` is one of:

- `running`: launch dispatched and an active managed workload verified.
- `pending`: reserved, never allocated.
- `uncertain`: allocated, but an active workload is not verified (a lifecycle-v0 row is never verified). The `legacy` status was removed *(post-cutover)*.

`origin` is `aico`, `a-term`, `cli` or `root` (created through `POST /v1/roots`).

`coordinator`, `coordinatorId` and `coordinatorColor`: see [Coordinators](#coordinators). `displayTitle` and `badge`: see [Display title and badge](#display-title-and-badge).

`available` is true only for `running`. An ended session is not listed; `GET` on it returns 404. A root keeps its ended tombstone under `/v1/roots`.

`instructions` is the Agent Hub prompt revision chosen when the session was created, `{prompt, name, revision, contentHash, createdAt}` (never the content), or null. A create passes the resolved snapshot `{prompt, name, revision, contentHash?, createdAt?, content}`; a tool without an adapter answers `400 instructions_unsupported` (docs/root-control.md "Chosen instructions").

`contextHook` *(post-cutover)* is Tether's latest check of the tool's Agent Hub context hook (see [Agent tools](#agent-tools)). `state` is `available`, `missing`, `unsupported`, `not_applicable`, or `unknown` when no check for the session's current `tool` has finished yet. `applicable` is false for a tool with no context mechanism (the bare shell). Tether checks after every launch, respawn, tool load and project switch, after its own restart (running sessions, one at a time, in the background) and on `POST /v1/sessions/:id/context-check`. A changed result publishes `session.updated`. The check is an independent probe: it never blocks the native tool, and it does not claim what an already-running session received.

`state` is the agent's state: `working`, `idle`, `blocked` (waiting on the user: a permission prompt or a question) or `unknown` (no agent found, or the session is not running). `stateSource` names what said so (`claude-status`, `claude-hook`, `codex-rollout`, `codex-hook`, `pi-session`, `none`), `stateAt` is when the state last changed (null while unknown), `stateDetail` says why it is blocked, and `statePrevious` is the state before (so `working` → `idle` is a finished turn, while `unknown` → `idle` is an agent Tether only just found). A change publishes `session.updated`. See [agent-state.md](agent-state.md).

`wakes` *(post-cutover)* lists the session's scheduled check-ins, oldest first; see [Wakes](#wakes).

### Agent Hub sessions

A session of tool `agent-hub` is a chat on an Agent Hub agent, not a terminal. Tether holds the Agent Hub session id instead of a pane, so there is no tmux session. Its descriptor adds `backend: "agent-hub"` (tmux sessions carry no `backend` field) and `agentHub: {sessionId, agentSlug, requestedModel, model, turnState, turnPhase, queued, reachable, created, promptSent}` (`sessionId` is the Agent Hub session id, `model` the one Agent Hub last reported, `turnState` `running`, `idle` or null before the first look, `turnPhase` Agent Hub's phase of a running turn, `queued` the follow-ups waiting for the turn to end, `reachable` whether Agent Hub answered the last poll). The `tmux` object keeps its shape with null fields, so existing readers do not break. `status` is `running` while Agent Hub reports the session active, `pending` until the Agent Hub session exists and the first prompt is posted (Agent Hub down at create; Tether keeps retrying), and `uncertain` when Agent Hub cannot be reached or has closed it. The agent state is `working` while a turn runs, `idle` between turns and `unknown` when Agent Hub is unreachable (`stateSource: "agent-hub"`).

What differs from a tmux session:

- `inject` needs `mode: "paste"` and `submit: true` (`400` otherwise) and posts the text as a turn. If a turn is running, or earlier follow-ups are queued, it is queued instead and the answer carries `queued: true`; one queued follow-up goes out each time the session goes idle, oldest first. `409 workload_unavailable` before the first prompt was posted, `503 agent_hub_unavailable` when Agent Hub cannot be reached (nothing queued). `model` (API 6; a catalog model id, or `null` for the agent's own routing) picks the model of that turn; left out, the turn uses the session's model. A queued follow-up keeps its own `model`, and the last choice becomes the session's model (`requestedModel` in the descriptor). `409 unknown_model` when Agent Hub cannot route the model; `400` on a tmux session.
- `attach`, `capture`, `scrollback`, `pane-mode`, `resize-claim` and `show` answer `409 workload_unavailable` (no pane; the native chat view uses the chat routes below). `respawn`, `load-tui`, `switch-project`, `agent-event` and `context-check` answer `409 unsupported_backend`.
- Naming, title, coordinator marks and wakes work as for any session. A wake delivers its note as a follow-up turn. A kept wake does not relaunch an ended Agent Hub session.
- End cancels a running turn, then closes the Agent Hub session, then drops the row (a queued follow-up goes with it). If Agent Hub cannot close it, End answers `blocked` and the session stays.
- After a Tether restart the session is found again by its stored Agent Hub id; a follow-up queued before the restart still goes out.
- Tether calls Agent Hub from its own process with the owner token read from `AGENT_HUB_OWNER_TOKEN_FILE` (or `TETHER_AGENT_HUB_OWNER_TOKEN_FILE`); the token never reaches a client, a log or this API. `TETHER_AGENT_HUB_URL` (default `http://localhost:8003`), `TETHER_AGENT_HUB_CLIENT_ID` (else `SUMMITFLOW_CLIENT_ID`) and `TETHER_AGENT_HUB_REQUEST_SOURCE` (default `aico-tether`) set the rest; `~/.env.local` supplies the fallbacks.

#### Chat routes *(apiVersion 5)*

A GUI shows a native chat for an Agent Hub session with these routes. All are for `agent-hub` sessions only: any other session, or one whose Agent Hub session is not created yet, answers `409 workload_unavailable`; an unknown session `404 not_found`; Agent Hub unreachable `503 agent_hub_unavailable`; a refusal from Agent Hub `409 workload_unavailable` with `reason`. None of them ever carries the owner token.

| Route | Request | Answer |
|---|---|---|
| `GET /v1/sessions/:id/chat` | query `messages=false` (optional, default true) | `200 {session, queued}`. `session` is the Agent Hub session JSON exactly as the SDK's `sessions.get` returns it, including `messages` (with `messages=false` it is the summary only, so the follow-up queue can be polled cheaply). `queued` is the follow-up texts waiting in Tether's durable queue, oldest first, always present. |
| `GET /v1/sessions/:id/chat/stream` | query `afterSeq=N` (optional integer, default 0; else `400 invalid_query`) | `200 application/x-ndjson`, one JSON object per line: each turn event or `idle` event from the SDK's `turns.attach(hubSessionId, {afterSeq})` as it is (events carry `seq`; `idle` does not), plus `{"type":"heartbeat"}` every 15 s while open. The stream ends after the turn's last event (`done`, `error`, `cancel_acknowledged`) or `idle`. The SDK reconnects a dropped Agent Hub connection by itself; if it gives up after headers were sent, the last line is `{"type":"stream_error","code":<SDK code or "stream_interrupted">,"message":<short text>}`. A failure before the first event is a normal error answer. Closing the connection stops the attach only; the turn keeps running. |
| `POST /v1/sessions/:id/chat/cancel` | `{generation}` | `200 {cancelled: boolean}`. `false` when no turn was running. `409 stale_generation` for another generation. |
| `GET /v1/chat/models` | none | `200 {items}`, the Agent Hub model catalog (the SDK's `models.list()` result), for a model picker. |

Sending a message uses the existing `inject` route (`mode: "paste"`, `submit: true`); its `queued` answer says whether the text waits for the running turn.

## Sessions

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/sessions` | none; query `project`, `origin`, `tool` | `{items: Descriptor[]}` from the catalog, with status from the last verification. A session whose current generation has never been verified (a fresh root or replacement) is verified first, so the list agrees with `GET /v1/sessions/:id` *(post-cutover)*. |
| `POST /v1/sessions` | `{tool?, projectId?, projectRoot?, blankSlate?, instructions?, name?, origin, aTermSessionId?, size: {cols, rows}}` | `201` running or `202` pending/uncertain descriptor. A `202` also carries `failure: {code, reason} \| null` (`workload_unavailable`, `outcome_uncertain`). `origin` is `aico`, `a-term` or `cli`; `aTermSessionId` (a UUID) is accepted only with `a-term`. `projectRoot` follows the `POST /v1/roots` path rule (absolute, normalized: no `.`/`..` segments or repeated `/`, no NUL; otherwise `400 invalid_body` with `field: projectRoot`) and must be an existing directory (`400 unknown_project`). With both `projectId` and `projectRoot`, the root is used as given and is not compared with the project's registered root. |
| `GET /v1/sessions/:id` | none | live-verified descriptor. Rechecks the generation after the async verification and returns `409 identity_changed` if it moved. |
| `PATCH /v1/sessions/:id` | `{generation, name}` | rename. `name: null` clears to the default label. The label follows the root title rules (trimmed, 1–160 UTF-8 bytes, no control characters). |
| `POST /v1/sessions/:id/end` | `{generation, keepWakes?}` | `200 {status:"ended", keptWakes}`. Exact containment retirement: stops only the owned pane scope and uses `cgroup.kill` fallback. End cancels the session's wakes; `keepWakes: true` *(apiVersion 3)* keeps them, and they relaunch the conversation when due (see [Wakes](#wakes)). |
| `POST /v1/sessions/:id/respawn` | `{generation}` | Replaces the pane workload with the session's stored tool. Returns the new descriptor and generation. A lifecycle-v0 session is refused with `409 workload_unavailable`. |
| `POST /v1/sessions/:id/load-tui` | `{generation, tool}` | Respawns with another tool and stores it on success |
| `POST /v1/sessions/:id/switch-project` | `{generation, projectId}` or `{generation, projectRoot}` *(post-cutover)* | With `projectId`: resolves the project root once, respawns there with the same tool, and stores `projectId`/`projectRoot`. With `projectRoot` (an existing directory under the same path rule as on create; Aico's Personal Workspace): respawns there and stores `projectId: null`. Exactly one of the two; a root that is not a directory is `400 unknown_project`. |
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

## Owner handoffs *(post-cutover)*

| Method and route | Body | Result |
| --- | --- | --- |
| `POST /v1/show` | `{session?, title?, url?, path?, paths?}`; exactly one of `url`, `path` and `paths` (absolute, existing files or folders, up to 20) | `201 {id, session, title, createdAt, kind: 'files', paths}` (real paths; a folder ends in `/`; nothing copied) or `{…, kind: 'url', url}`, and a `show.requested` event with the same data. |
| `GET /v1/shares` | — | `200 {items}`: the newest 200 shares, oldest first, kept for `TETHER_SHARE_RETENTION_DAYS` (default 30). |

This hands a file or link to the owner's apps through `GET /v1/events`.
It is independent of `POST /v1/sessions/:id/show`, which focuses a session view.
`session` is an optional eight-character lowercase hex Tether ID (the pane's
`AICO_WIDGET_ID`), used as attribution without requiring a live catalog entry.
Absent `session` and `title` are returned as `null`. `title` is plain text, at
most 120 Unicode characters, without control, format or line separator characters.
Apps must render it as text. `url` must be an absolute HTTP(S) URL, at most 2000
Unicode characters, without control characters or surrounding whitespace.
For URLs, `kind` is `"url"`, and both `name` and `url` contain the supplied URL.
Tether does not fetch the URL.

`path` must be absolute and name a regular file. Tether opens it with
`O_NOFOLLOW` (symlinks are refused), checks the size and copies from that open
descriptor. The cap is also enforced while reading, so file growth cannot
produce an oversized handoff. The copy is
`<exchange>/agent/<session-or-none>/out/<id>-<basename>`, with a random 12-character
hex `id`. The basename uses only `[A-Za-z0-9._-]` and is truncated to 80 characters.
For files, `kind` is `"file"`, `name` is the copy's path **relative to
`<exchange>/agent`** (for example `0123abcd/out/abcdef123456-report.pdf`), and `url`
is absent. The event and response never include file contents or the source path.
The copy closes before the event is published. New handoff directories are 0755,
copies are 0644, and symlink handoff directories are refused.

Daemon configuration is read from `TETHER_EXCHANGE_ROOT` (default
`/srv/workspaces/exchange`, an absolute path) and `TETHER_SHOW_MAX_BYTES` (default
`26214400`, 25 MiB, a positive integer). The exchange root must already exist;
Tether never creates it. A root installation creates it with permissions allowing
the agent daemon to create `agent/` and the owner apps to traverse it.

Malformed bodies return `400 invalid_body`; unreadable, missing, symlink or
nonregular sources return `400 invalid_file`; oversized files return
`413 file_too_large` with `maxBytes`; an absent or invalid exchange root or a
symlink handoff directory returns `503 exchange_unavailable` with a clear
`detail`. Failed requests publish no event. URL requests do not need the exchange.

`st show <url|file> [--title T]` posts to the agent instance at
`$XDG_RUNTIME_DIR/tether/default/control.sock`. A successful request records the handoff;
owner-app notification handling is a separate consumer of `show.requested`.

## Terminal I/O

Apps keep their own byte path: a PTY that runs `tmux attach` against the session's private socket. Tether hands out the target. It never proxies terminal bytes.

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/sessions/:id/attach` | none | `{generation, argv: ["/usr/bin/tmux","-S","<socket>","attach-session","-t","$3"], env, unset}`. `argv` is the exact client argv. |
| `GET /v1/sessions/:id/capture` | query `escapes=1` | `{generation, text}`: the visible screen |
| `GET /v1/sessions/:id/scrollback` | query `fromLine`, `count` (at most 5000, default 5000), `escapes=1` | `{generation, fromLine, totalLines, historySize, text}`. One bounded page of pane history (Aico `scrollback-page.ts`); line `historySize + r` is visible row `r`. Without `fromLine`, the last page. `400 invalid_query` for a non-integer. |
| `POST /v1/sessions/:id/inject` | `{generation, text, mode: "type" \| "paste", submit?: bool, model?: string \| null}` | `{generation, delivered: true}`; an `agent-hub` session adds `queued: bool` ([Agent Hub sessions](#agent-hub-sessions)) |
| `GET /v1/sessions/:id/pane-mode` *(post-cutover)* | none | `{generation, alternateScreen, mouseReporting, historySize, inMode, mode}`: whether the pane shows its alternate screen, whether the program asked for mouse reporting, the history line count, and whether tmux shows a mode over the pane (`mode` is its name, such as `copy-mode`, else null). Read-only `display-message`. `409 workload_unavailable` when tmux cannot answer. |

Attach `env` holds **overrides only**, not a full environment: set exactly `TERM=xterm-256color`, `COLORTERM=truecolor` and `CLICOLOR=1` over the client's own environment, then remove every key in `unset` (`TMUX`, `TMUX_PANE`, `TMUX_TMPDIR`, `NO_COLOR`). Both lists may grow additively.

`mode: "type"` sends `send-keys -l`. `mode: "paste"` sends one bracketed-paste event; with `submit: true` it is followed by one Enter. Text must pass Aico's `isBoundedTerminalText` rule: nonblank, at most 2000 UTF-8 bytes, and no control characters except tab and newline. Injection is framing only. A `delivered` result does not mean the agent accepted the text, and it does not rule out a concurrent human draft. Injection is refused for non-`running` sessions.

### Active-client resize claim

When a view becomes active, it claims the shared tmux window size:

`POST /v1/sessions/:id/resize-claim` with body `{generation, clientPid, cols, rows, viewer?}` returns `200 {applied: true, changed}` or `{applied: false, reason}`. `changed` is true when the window's size differed before the claim, so a view that took the size back knows to repaint. A successful claim also moves the foreground pane's `MemoryLow=2G` to this session's pane scope, since Aico claims the size when a view gains focus.

`POST /v1/sessions/:id/show` with body `{generation}` asks the connected GUI to open or focus the session's view. It returns `200 {shown: true}`, `503 gui_unavailable` with no GUI connected, or `409` when the session is not running or the GUI rejected the command.

`viewer` *(post-cutover, apiVersion 2)* names the claimer for the other views: `{app, device}`, exactly those two keys, `app` a lowercase slug (`desktop`, `web`; 1–32 of `a-z0-9-`, starting with a letter) and `device` 1–64 characters with no control characters or surrounding spaces (the desktop sends its hostname). It is optional; a malformed one is refused with `400 invalid_viewer` before anything else about the session is checked.

Tether resizes only the window of the attached tmux client whose `client_pid` is `clientPid` (Aico `activateTmuxViewSize`). `reason` is one of *(3a)*:

| Reason | Retry? | Meaning |
| --- | --- | --- |
| `client_not_attached` | yes | No tmux client with that pid is attached exactly once, or it detached or switched windows during the claim. Retry after the attach settles. |
| `stale` | yes | The generation changed during the claim. Re-read the session. |
| `tmux_unavailable` | yes | A tmux query failed (server going away). |
| `window_linked` | no | The client's window is linked into another session. |
| `status_row` | no | The session shows a tmux status row (`status` is not `off`, including the global value). |
| `invalid` | no | `clientPid`, `cols` or `rows` is not a positive integer. |

A stale or wrong-workload `generation` is refused before the claim with `409 stale_generation` / `409 workload_unavailable`. A successful claim records the claiming client as the session's **size holder** (the client the shared window now fits; any other attached client sees the window at a size that is not its own) and publishes `session.resized` with `{id, generation, clientPid, cols, rows, changed, viewer}`. A client compares `clientPid` with its own attached client's pid to learn it no longer holds the size. `GET /v1/sessions/:id/resize-claim` returns `{generation, holder}`, where `holder` is `{clientPid, cols, rows, generation, claimedAt, viewer}` or `null` when unknown (no claim yet, or Tether restarted; the holder is kept in memory only). `viewer` is `null` when the claimer sent none. Desktop auto-resize on active-client change is intended behavior. The web app claims only when its view becomes active, not on every resize.

## Roots

A root is a session created through the root contract with a stable caller `requestId`. The [root contract](../../docs/root-control.md) (moved from Aico at the cutover) holds the digest, tombstones, the resume adapters and every validation rule. Mutations serialize on the session identity and share one handler with the widget routes.

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/roots` | query `origin=aico\|a-term` *(3a)*, `ended=0\|1` *(post-cutover)* | `{owner, available, directedDelivery, roots: Descriptor[]}`. `owner` is the `origin` filter, else `"aico"`. `ended=0` leaves out ended tombstones (they stay readable at `GET /v1/roots/:requestId`). `400 invalid_query` for another origin or `ended` value. |
| `POST /v1/roots` | `{requestId, tool, projectId, projectRoot, initialPrompt, role, leadRootReference?, facetCapsuleRef?, resumeSessionId?, model?, agentSlug?, origin?, aTermSessionId?, launchedBy?}` | Existing or reserved root descriptor. Tool `agent-hub` starts an Agent Hub chat session ([Agent Hub sessions](#agent-hub-sessions)): `agentSlug` is required for it (and refused for any other tool), `model` is optional, `resumeSessionId`, `reasoningEffort` and `daybreak` are refused, and `projectRoot` only has to be an existing directory. `422 unknown_agent` or `unknown_model` when Agent Hub does not know the agent or model, `503 agent_hub_unavailable` when it cannot be reached (nothing is reserved). `200` for running or ended, `202` for pending or uncertain. `400 unsupported_tool` with `supported: slug[]` for a tool that can't start a root (`rootCapable: false`). `400 prompt_too_long` with `limit` when `initialPrompt` exceeds 14 KiB fresh or 2000 bytes on resume ([root-control.md](../../docs/root-control.md)). `409 request_conflict` if the same key arrives with a different digest. `409 recovery_pending` with `widgetId` when a new request's `resumeSessionId` is a conversation that [crash recovery](crash-recovery.md) is about to resume, or holds, in that session. |
| `GET /v1/roots/:requestId` | none | Current descriptor, including ended tombstones (`status: "ended"`, `generation: null`). Every root descriptor carries `launch`: null, or `{state: "deferred", reason, checkedAt, nextRetryAt, attempts}` while host admission holds a pending launch back. Tether tries it again every 30 s, the same way as repeating the create, until it starts or the root ends. The record lives in memory, so a Tether restart drops it; repeat the create then. |
| `POST /v1/roots/:requestId/show` | `{generation}` | Forwarded to the GUI |
| `POST /v1/roots/:requestId/position` | `{generation, bounds: {x, y, width, height}}` | Forwarded to the GUI |
| `POST /v1/roots/:requestId/title` | `{generation, label}` | Renames the session in Tether and forwards to the GUI |
| `POST /v1/roots/:requestId/end` | `{generation}` | Same as session End. The tombstone is retained. |
| `POST /v1/roots/:requestId/send` | none | `503 directed_delivery_unavailable` |
| `GET` and `POST /v1/roots/:requestId/admin` | as in Aico | Generation-checked, fail-closed `503`. No terminal input. |
| `GET /v1/widgets/:id` | none | Compact descriptor `{owner:"aico", widgetId, sessionId, generation, status, available}` |
| `POST /v1/widgets/:id/title` | `{generation, label}` | As for roots |
| `POST /v1/widgets/:id/position` | `{generation, bounds}` | As for roots |
| `POST /v1/widgets/:id/coordinator` | `{generation, coordinator: boolean \| widgetId}` | Marks, unmarks or joins a coordinator in the catalog (see [Coordinators](#coordinators)) and forwards it to the GUI when one is connected |

The root descriptor keeps Aico's fields: `owner`, `hostIdentity`, `generation`, `logicalSessionId`, `surfaceLocator`, metadata, `bounds` and `status`. `bounds` is always `null` from Tether: window geometry belongs to the GUI.

Root origin *(3a)*: `origin` is `"aico"` (default) or `"a-term"`; `aTermSessionId` (a UUID) is accepted only with `"a-term"` and becomes the pane's `A_TERM_SESSION_ID`. Neither is part of the request digest. A root's `owner` is its stored origin and the descriptor also carries `origin`. The pre-Tether sockets `/run/user/<uid>/aico/control.sock` and `gui-control.sock` were removed on 2026-10-24; `st aico` and SummitFlow fleet use this socket.

Root window *(post-cutover)*: once a new root is running, Tether asks the connected GUI to show it only when the desktop or `st aico create` requested it (session origin `root`). A root the web app started (origin `a-term`) joins the desktop catalog and tray without a window, so no window layout is written for it.

Root-request tombstones from Aico are imported by `tether import-aico`; there is no separate tombstone import route.

Generation fencing:

- Every mutation requires the exact current generation and a `running` workload.
- A stale generation returns `409 stale_generation`.
- `pending` or `uncertain` returns `409 workload_unavailable`.
- If the session retires while the request waits, the response is `410 ended`.
- A root that has ended returns `410 ended`. Its tombstone means the same `requestId` can never start new work.

### Coordinators

A coordinator is a session that launches and steers other sessions (lanes). The catalog is the one record of who coordinates whom; the desktop and web app both draw it from the descriptor.

- `launchedBy` on `POST /v1/roots` names the session that asked for the root (`st aico create` sends its `AICO_WIDGET_ID`, from the desktop or web app). It is not part of the digest and only counts when the root is first reserved. If the launcher belongs to a coordinator, the new root belongs to that same root coordinator, so a lane's helpers join the lane's coordinator. Otherwise the launcher becomes a coordinator and the root belongs to it. An unknown launcher records nothing.
- `coordinator` is true for a coordinator. `coordinatorId` is the root coordinator that launched this session, or null (always null for a coordinator). It stays set after that coordinator ends.
- `coordinatorColor` is the coordinator's colour, `#rrggbb` from a fixed palette of eight, on the coordinator and on each of its lanes. A new coordinator takes the first colour no other coordinator holds, so coordinators on screen together differ until there are more than eight. Lanes keep their colour after the coordinator ends.
- `POST /v1/widgets/:id/coordinator` marks or unmarks one by hand (`st aico widget coordinator on|off`), with or without a GUI connected, and publishes `session.updated`. Unmarking frees the colour; lanes keep theirs.
- `coordinator: "<widgetId>"` (`st aico widget coordinator join <widgetId>`) makes the session a lane of that session's root coordinator, marking it a coordinator if it is not one or a lane already. The session stops being a coordinator and its own lanes move with it. This repairs sessions that predate `launchedBy` and were promoted when they launched helpers. The GUI hears only `coordinator: false`; lineage reaches it on the descriptor.

### Display title and badge

Tether names every session once, and the desktop, the web app and `st` show these fields as they are, without composing their own.

- `displayTitle` is `Project — Task`: the project's name from the project list (Aico's Personal Workspace root is "Personal Workspace") and the session's `name`. Either one alone when the other is missing or the task only repeats the project; `Session <n>` when both are missing.
- `badge` is `{kind, text, color}` or null. A coordinator has `{kind: "coordinator", text: "Coordinator"}`. A session it launched has `{kind: "child", text: "↳ <coordinator>"}`, naming the root coordinator by its task, else its project, else "Coordinator" (ended). `color` is `coordinatorColor`, or `#6fa8ff` for sessions from before colours.
- A rename, a project switch or a changed project name publishes `session.updated` for the session. A renamed coordinator also publishes its lanes, whose badge text changed. Tether rereads project names every five minutes.

### GUI view-mutation forwarding

Show, position, title and coordinator change views, and views belong to the app. Tether forwards them to one connected Aico GUI client:

1. The Aico GUI opens `GET /v1/gui/channel` with header `x-tether-client: aico-gui`. This is a long-lived NDJSON stream of `{commandId, kind, sessionId, generation, bounds?, label?, coordinator?, ifViewed?}`. `ifViewed: true` on `show` (sent for a due wake) reopens the session's window only if the desktop has shown that session before, without taking focus; an open window is left as it is, and a session the desktop never showed answers `no_view`. While the owner is working in the web app (the web app made a size claim and the owner has not typed, clicked or scrolled in a desktop window since; at launch, a web claim Tether remembers from after the owner last used the desktop), the desktop opens, reopens and raises nothing for any `show` and answers `owner_on_web`; the routes that forward it answer `409 owner_on_web`. Only one GUI channel is active per instance. A second one replaces the first, which receives `{type:"superseded"}` and is closed.
2. For each command, the GUI verifies and applies the change (Aico `widgetMutationOperation`). It then posts `POST /v1/gui/results/:commandId` with `{applied: true}` or `{applied: false, error}`.
3. Tether answers the original caller with the GUI's result. A command that gets no result within 5 s answers `409 outcome_uncertain`.

`GET /v1/gui/layout` reads the connected Aico GUI's current window picture over this same channel. It sends `{type:"command", commandId, kind:"layout"}` without a session or generation; the GUI replies with `{applied:true, layout}` using the existing v1 layout snapshot (`v`, `pid`, `startTime`, `updatedAt`, `displays`, `windows`). This read never opens, focuses, moves, or changes a session. The route returns the snapshot directly, `503 gui_unavailable` when no GUI is connected, or `504 gui_timeout` on timeout/disconnect. The GUI may reject a read while quitting or before it is ready. Mutation commands retain their existing generation checks and result bodies.

`st aico layout` uses this route on the socket selected by `TETHER_SOCKET`, or the current runtime's Tether instance. `AICO_LAYOUT_FILE` explicitly selects a fixture/offline file instead; file reads retain writer PID/start-time freshness checks.

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
  "updatedAt": 0,
  "rootCapable": true
}
```

How tool fields work:

- `argv` is authoritative. `command` is accepted on input for web app compatibility. It is split on spaces and tabs, and only plain words are allowed: no quotes, `$`, globs, redirections or operators (`400 invalid_command`). On output, `command` is the shell-quoted rendering of `argv`.
- An empty `argv` is the bare shell.
- Setting `isDefault: true` atomically clears the previous default. If no enabled tool is marked default, the first enabled tool by `displayOrder` is used.
- Slugs and aliases share one namespace (`409`/`400 slug_conflict`).
- `contextHook` is one of `claude-session-start`, `codex-hooks`, `pi-extension` or `canonical-retrieval:antigravity`. Tether verifies it at launch (Aico `tui/context.ts`). A failed check stays visible but never blocks the native TUI.
- Resume adapters (Codex `resume --no-daemon <uuid>`, Claude Code `--resume <uuid>`, Pi `--session <uuid>`) are code, not data. They are keyed by canonical slug and cannot be edited through this API. Pi root creation requires an explicit provider/model selection; automatic Pi session discovery is unavailable.
- `rootCapable` is read-only and derived: true exactly when the tool has a resume adapter, because a root must be resumable after a crash. Only those tools can start a root ([root contract](../../docs/root-control.md#create)).
- This list is the one source of tool names, colours (`color` may be `null`), process names and root capability for both apps.

Seeded tools, from the Aico TUI specs reconciled with the web app's live rows:

| Slug | argv | Default | Notes |
| --- | --- | --- | --- |
| `claude-code` | `claude --dangerously-skip-permissions` | | Alias `claude` (the web app's old slug) |
| `codex` | `codex --yolo` | yes | Owner decision. Aico's tray default was `claude-code`. |
| `agy` | `agy --dangerously-skip-permissions` | | |
| `pi` | `pi --approve` | | Aico's flag. The web app's bare `pi` showed Pi's project-trust prompt. |
| `shell` | (empty) | | Interactive login shell |

There is no `aider` row, on purpose: Aider isn't installed and no session has run it. The web app's own-tmux discovery still lists it among the commands it recognises; once that discovery reads process names from this list, Aider sessions are no longer picked up. Add a row (it can be disabled) if that's ever wanted.

## Projects

`GET /v1/projects` (query `refresh=1` bypasses the cache) returns `{source, fetchedAt, activeProjectId, projects: [{id, name, root, lifecycle, current}]}`.

`activeProjectId` and `current` *(post-cutover)* name SummitFlow's persisted active project (`st projects active`), read from its pointer file `~/.local/share/st/active-project.json` on every request. It is null, and every `current` false, when the file is absent or malformed or names a project that is not listed. `TETHER_ACTIVE_PROJECT_FILE` overrides the path; `off` ignores it. Changing the pointer publishes no event.

`source` is one of:

- `summitflow`: from SummitFlow's `GET http://127.0.0.1:8001/api/projects` over loopback with no token, cached for 30 s. Archived projects are excluded.
- `summitflow-cache`: SummitFlow is unreachable, so the last good answer is served.
- `local`: SummitFlow is not installed or not reachable and there is no cache. The list comes from `~/.config/tether/projects.json`, a list of `{id, name?, root}`; entries whose roots are not directories are skipped.

`TETHER_SUMMITFLOW_URL` overrides the URL. Set it to `off` to disable SummitFlow. `refresh=1` re-reads `projects.json` in local mode.

`POST /v1/projects` *(3a)* with `{id, root, name?}` registers a project in local mode: it appends to `projects.json` atomically (temp file and rename, mode 0600), refreshes the list, returns `201 {id, name, root, lifecycle: null}` and publishes `projects.changed`. Errors: `400 invalid_project_id` (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`), `400 invalid_project_root` (not an absolute directory), `409 project_exists`, `409 local_projects_unreadable`, and `409 projects_managed_by_summitflow` when the source is SummitFlow (register the project there).

## Workflow runs

Agent Hub workflow runs (`st workflow create`) show as children of the session that launched them. A run records `launched_by`, the launching session's `ownershipId` (`AICO_SESSION_ID`). Tether asks Agent Hub through the SDK for the runs of each live session by that id and keeps them as team members: a **run** folds under the session, its **steps** under the run. A run started outside Aico has no `launched_by` and is never listed. Tether calls Agent Hub with the same owner token and settings as an Agent Hub session (above); the token never reaches a client.

`GET /v1/runs` answers `{status, error, updatedAt, items}`. `status` is `ok`, `stale` (the last look failed; `items` is the last answer) or `unavailable` (no look has worked since Tether started); `error` says why in plain words; `updatedAt` is the last good look (ms). Each item is a team member (`id`, `coordinator: false`, `coordinatorId`, `group`, `at`, `kind`, `summary`; see the clients' `foldTeams`) with:

- `kind` `run` or `step`; `id` `run:<runId>` or `step:<runId>:<key>`; `runId`, `stepKey` (null on a run);
- `coordinatorId`: the launching session's id for a run (a session that has ended leaves the run top level while it is active), the run's `id` for a step;
- `group`: run `running` is `working`, `needs_owner` `needs-you`, `completed` `finished`, `failed` and `cancelled` `no-status` (ended); step `running` is `working`, a step waiting on the owner `needs-you`, pending and done `idle`, failed, refused and cancelled `no-status`. `word` is the state in words (`thinking`, `writing`, `tool bash`, `provider retry` for a running step; `waiting for you`; `failed`); `status` is Agent Hub's own;
- `title` (the run's goal, the step's key), `url` (the run page in Agent Hub), `agent`, `requestedModel` and `servedModel`, `fallback` (another model answered), `attempt` and `attemptLimit`, `reason` (why it waits or failed), `cancelling`, `summary` (a run's steps counted: `2 done · 1 working`), `hint` (on a live run: plan changes stay with the coordinator);
- `can`: `decide` (a step waiting on the owner, or a pause that names no step on the run; not `blocked_dependencies`), `cancel`, `dismiss` (an ended run).

Controls, each `{ok: true}` or an error; Tether controls only a run it lists (`404 unknown_run`, `404 unknown_step`, `409 not_allowed`, `409 agent_hub_refused` with `reason`, `503 agent_hub_unavailable`):

| Method and route | Body | Result |
| --- | --- | --- |
| `POST /v1/runs/:runId/resume` | `{action: "retry" \| "skip" \| "fail", stepKey?}` | answer the waiting step (or the run) |
| `POST /v1/runs/:runId/cancel` | none | stop the run |
| `POST /v1/runs/:runId/steps/:key/cancel` | none | stop one step |
| `POST /v1/runs/:runId/dismiss` | none | drop an ended run from the lists (kept across restarts) |

Following a run (settings, as data): `TETHER_AGENT_HUB_RUNS_POLL_MS` (default 3000), `TETHER_AGENT_HUB_RUNS_ENDED_MS` (an ended run stays listed this long after its last activity unless dismissed; default 6 hours), `TETHER_AGENT_HUB_RUNS_LIMIT` (30) and `TETHER_AGENT_HUB_RUNS_CONCURRENCY` (4). The run page address is `TETHER_AGENT_HUB_FRONTEND_URL`, else `AGENT_HUB_FRONTEND_URL` (as `st workflow` reads it), else the API host on port 3003. Plan changes (follow-up) are not an Aico control: the coordinator makes them with `st workflow add-step`, `revise` and `remove-step`.

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
- `gui.connected`, `gui.disconnected`
- `wakes.changed` (`{sessionId}`; null for a kept wake of an ended session)
- `runs.changed` (`{}`; the listed workflow runs changed, re-read `GET /v1/runs`)

`session.created` and `session.updated` carry `session` *(post-cutover)*: the session descriptor as `GET /v1/sessions` would list it, with a status verified for the exact generation the event announces. Clients can apply it instead of fetching the descriptor; one that sees no `session` (an older Tether) re-reads. Session events are published in order through one queue. `session.ended` carries the ID (and generation) only; `session.resized` adds the size holder as above.

Events never carry terminal contents or prompts. A `session` snapshot carries the session's name and label, which every `GET /v1/sessions` caller on the same socket can read anyway.

SSE was rejected. NDJSON is simpler to consume from both Node and Python (`httpx` line streaming) over a Unix socket, and browsers never connect to Tether directly.

## Memory policy

Tether owns the agent-pane memory policy: the pane cap and the kill policy for runaway agent tool jobs. Host memory
(the host's pressure state in Nightshift's `admission.json`, swap, systemd-oomd, the app.slice cap) stays with
Nightshift. The web app's settings panel edits it.

- `GET /v1/memory-policy` returns `{policy, defaults, bounds, killOrders, guard}`. `guard` is `{running, hostState,
  lastKillAt, paneCapFile}`; only the default instance runs the guard.
- `PUT /v1/memory-policy` takes any subset of `policy` and returns the same shape; a bad field is `400 invalid_body`
  with `field` and `detail`. It publishes `memory-policy.changed`.

| Field | Default | Meaning |
|---|---|---|
| `paneMemoryMaxGib` | 12 | MemoryMax of every `tmux-spawn-*.scope` pane (2-64) |
| `paneSwapMaxGib` | 2 | MemorySwapMax of every pane (0-16) |
| `killEnabled` | true | kill the largest agent tool job when host memory is critical |
| `killAfterSeconds` | 10 | memory must have been critical this long first (5-300) |
| `killGapSeconds` | 30 | at most one kill per this many seconds (10-600) |
| `killMinGib` | 1 | smaller jobs are left to the pane cap and the kernel (0.25-16) |
| `killOrder` | `largest` | `largest`, or `background-first`: spare the pane the owner is looking at while a background pane has a job big enough |

The cap is the drop-in `~/.config/systemd/user/tmux-spawn-.scope.d/40-tether-pane.conf`, written only while panes are
on OOMPolicy=continue (a pane past it loses one process and keeps running); every 5 s the guard also caps any running
pane at no cap, or at the cap the owner just replaced, unless it is already near the cap. A cap raised by hand at
runtime is kept. The guard (`src/lifecycle/job-guard.ts`) never kills a pane's root shell or its agent; it writes
`kill`, `warning` and `agent-hog` records with killer `tether` to Nightshift's memory event record
(`~/.local/state/nightshift/memory-events.jsonl`, schema v1; `TETHER_NIGHTSHIFT_EVENTS` names another absolute path, which
the agent user's unit uses to keep the record in its state dir where Nightshift reads it) before acting, and its heartbeat
`$XDG_RUNTIME_DIR/tether/default/memory-guard.json` (`v, ts, pid, host_state, critical_since, last_kill_at,
kill_enabled, kill_candidate`) tells Nightshift whether a job it may stop exists and that the guard is alive.

## Wakes *(post-cutover)*

A wake is a scheduled check-in on a session: a time and a short note. Agents set their own with `st aico wake`; the
owner sets and cancels them from the desktop tray and the web app. Tether is the only scheduler, and the `wakes` table
survives Tether restarts and reboots. The design is in `docs/plans/session-wakes.md` at the repository root.

When a wake is due, Tether asks the desktop to reopen the session's window (`show` with `ifViewed`) and waits until
the agent is `idle`, no attached client has sent a key for `quietSeconds`, and the agent's input line holds no draft.
It then pastes one message for all of the session's due wakes, oldest first, and submits it:
`[Scheduled check-in for 5:30 PM, 12 min late] check the lane reports`. Each wake goes out at most once. A wake that
was due while Tether or the host was down goes out when the gates next pass. Closing a window does not cancel a wake.

End cancels the session's wakes unless the End request says `keepWakes: true`. A kept wake outlives the session: when
due, Tether starts a new session with the ended session's tool, project, name and coordinator lineage, resuming its
conversation when Tether saw its conversation ID (the message then adds `resumed after End`). If a running session
already holds that conversation, the wake moves to it instead. A relaunch the host refuses for now (admission, linger)
waits a minute and tries again; one that fails counts an attempt, and after `relaunchAttempts` the wake stays listed
with its `lastError` until the owner moves or cancels it.

Wakes need an agent whose state Tether reads (Claude Code, Codex). Pi and the shell report no state, so setting a wake
on them is `409 wake_unsupported`.

An Agent Hub session ([Agent Hub sessions](#agent-hub-sessions)) takes wakes too. It has no window, keys or draft, so
the only gate is that its turn is `idle`; the message then goes out as a follow-up turn. A kept wake of an ended Agent
Hub session is not relaunched: it stays listed with a `lastError` until the owner moves or cancels it.

| Route | Request | Response |
|---|---|---|
| `GET /v1/wakes` | | `{items, policy}`, every wake, soonest first |
| `GET /v1/sessions/:id/wakes` | | `{items, policy}` for one session |
| `POST /v1/sessions/:id/wakes` | `{dueAt, note, createdBy?}` | `201` the wake. `dueAt` is epoch ms, at most 5 minutes past and 366 days ahead; `note` is one line (line breaks become spaces) of at most `noteMaxChars`; `createdBy` is `agent` (default) or `owner`. `409 wake_unsupported`, `409 too_many_wakes {max}` |
| `PATCH /v1/wakes/:wakeId` | `{dueAt?, note?}` | `200` the wake; resets a kept wake's failed attempts |
| `DELETE /v1/wakes/:wakeId` | | `200 {deleted: true}` |
| `GET /v1/wake-policy` | | `{policy}` |
| `PUT /v1/wake-policy` | any subset of `policy` | `{policy}`; a bad field is `400 invalid_body` with `field` and `detail` |

A wake is `{id, sessionId, dueAt, note, createdAt, createdBy, kept, attempts, lastError}`. A kept wake whose session
ended has `sessionId: null` and `endedSession: {id, name, tool, projectId}`. Every change publishes `wakes.changed`,
and `session.updated` for the session it belongs to.

| Policy field | Default | Meaning |
|---|---|---|
| `laterMinutes` | 60 | the apps' "In 1 hour" quick choice (5-1440) |
| `tonightHour` | 21 | "Tonight": this hour today, or tomorrow once passed (0-23) |
| `morningHour` | 8 | "Tomorrow morning" (0-23) |
| `maxPerSession` | 5 | wakes one session may hold (1-20) |
| `noteMaxChars` | 500 | (20-1500) |
| `quietSeconds` | 15 | no key from an attached client for this long before a delivery (0-300) |
| `lateNoticeMinutes` | 5 | a later delivery says how late it is (1-1440) |
| `relaunchAttempts` | 15 | failed relaunches of a kept wake before it waits for the owner (1-100) |

## Crash recovery

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/recovery/status` | none | Crash records: waiting, recovering, recovered or held ([crash-recovery.md](crash-recovery.md)) |
| `POST /v1/recovery/:id/resume` | none | `202 {id, state:"waiting"}`: try a held session again now. `409 not_held` otherwise. |

Absent when the daemon runs with `TETHER_RECONCILE=off`.

## Health and version

`GET /v1/health` never touches tmux. It returns:

```json
{"status":"ok","name":"tether","instance":"default","version":"0.1.0","apiVersion":5,"schemaVersion":12,
 "uptimeMs":966,"bootId":"uuid","eventSeq":0,"catalog":{"sessions":0,"tmuxServersActive":0,"rootRequests":0},
 "gui":{"connected":false},"lifecycle":"ready"}
```

`lifecycle` is `"reconciling"` until startup reconciliation finishes, then `"ready"`. It is `"disabled"` when the daemon runs with `TETHER_RECONCILE=off` (tests and catalog inspection): startup never observes, adopts or stops a tmux server and the pane-exit watcher is off. Use it only for tests and read-only inspection of a catalog.

`GET /v1/version` returns `{name, version, apiVersion, minApiVersion, node}`.
