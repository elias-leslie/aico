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
- Versioning: `apiVersion` is an integer. v1 only grows additively: new routes, new optional request fields, new response fields, new event types. Clients ignore unknown response fields and event types. A breaking change ships as `/v2` next to `/v1`. Apps declare the minimum `apiVersion` they need and compare it with `GET /v1/version`; an addition an app depends on (a request field an older Tether would refuse) raises `apiVersion`. 2 *(post-cutover)*: the resize claim's `viewer`. 3 *(post-cutover)*: session wakes and End's `keepWakes`. 4: shares link files where they are. 5-7: chat routes and a chat `inject` model (retired with the Agent Hub chat backend). 8: [remote hosts](#remote-hosts): `host` on descriptors, create, roots, tools and projects; `peer` marks; `GET /v1/hosts`; the `peer.state` and `peer.resync` events; root `lineage`. 9: `parentId` on descriptors and in root `lineage` ([Coordinators](#coordinators)). 10: [placement](#remote-hosts): `host: "auto"` with `needs` on `POST /v1/roots`, `GET /v1/placement`. 11: placement `pool` on both. 12: [lane reports](#lane-reports): `stateAgentAt`, `waitingOn` and `launched` on descriptors, `/v1/sessions/:id/watches`, and wake lists show check-ins only. 13: [waits](#waits): `/v1/waits`, `/v1/sessions/:id/waits`, `inject` takes `from`, End answers `keptWaits`. 14: placement `needs` with a named `host`, and placement.json `hosts.<name>.room: "local"`. 15: root `entry` ([Roots](#roots)). 19: root `entry` on `codex` roots. 20: root `entry` on `pi` roots. 21: End's `endedBy` ([Lane reports](#lane-reports)). 23: the hub takes a forwarded End's asker in the `Tether-Ended-By` header ([Lane reports](#lane-reports)). 24: delivery classes: `ride` and `from` on `POST /v1/sessions/:id/deliveries`, `GET /v1/sessions/:id/due?ride=1` ([Deliveries](#deliveries)). 25: `reply` on a delivery, `GET /v1/sessions/:id/due?ride=peek` and `DELETE /v1/sessions/:id/due?token=` ([Deliveries](#deliveries)). 26: asks that want files: `files` on `POST /v1/asks` and on an answer, `wantsFiles` and `files` on the ask ([Asks](#asks-post-cutover)). 27: [session history](#session-history): `GET /v1/history`, `/v1/history/:id`, `/v1/history/:id/events` (schema 31). 28: [coordination documents](#coordination): `/v1/coordination/docs`. 30: [session history](#session-history): `session` on `GET /v1/history` and `contextTokens` on the summary (schema 34). 31: `open` and `origin` on `POST /v1/asks` and on the ask: the https link the card opens, and who filed it when an app did (schema 35). 32: `attach` on `POST /v1/asks` and `attached` on the ask ([Asks](#asks-post-cutover)).
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
  "parentId": "d2852144",
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
  "stateAgentAt": 1791689998000,
  "waitingOn": null,
  "launched": true,
  "wakes": [{"id": "5f1c0a9b2e7d", "dueAt": 1791693000000, "note": "check the lane reports", "createdBy": "agent"}],
  "createdAt": 1791686790237
}
```

`status` is one of:

- `running`: launch dispatched and an active managed workload verified.
- `pending`: reserved, never allocated.
- `uncertain`: allocated, but an active workload is not verified (a lifecycle-v0 row is never verified). The `legacy` status was removed *(post-cutover)*.

`origin` is `aico`, `a-term`, `cli` or `root` (created through `POST /v1/roots`).

`coordinator`, `coordinatorId`, `coordinatorColor` and `parentId`: see [Coordinators](#coordinators). `displayTitle` and `badge`: see [Display title and badge](#display-title-and-badge).

`available` is true only for `running`. An ended session is not listed; `GET` on it returns 404. A root keeps its ended tombstone under `/v1/roots`.

`instructions` is the Aico prompt revision chosen when the session was created, `{prompt, name, revision, contentHash, createdAt}` (never the content), or null. A create passes the resolved snapshot `{prompt, name, revision, contentHash?, createdAt?, content}`; a tool without an adapter answers `400 instructions_unsupported` (docs/root-control.md "Chosen instructions").

`contextHook` *(post-cutover)* is Tether's latest check of the tool's Aico context hook (see [Agent tools](#agent-tools)). `state` is `available`, `missing`, `unsupported`, `not_applicable`, or `unknown` when no check for the session's current `tool` has finished yet. `applicable` is false for a tool with no context mechanism (the bare shell). Tether checks after every launch, respawn, tool load and project switch, after its own restart (running sessions, one at a time, in the background) and on `POST /v1/sessions/:id/context-check`. A changed result publishes `session.updated`. The check is an independent probe: it never blocks the native tool, and it does not claim what an already-running session received.

`state` is the agent's state: `working`, `idle`, `blocked` (waiting on the user: a permission prompt or a question) or `unknown` (no agent found, or the session is not running). `stateSource` names what said so (`claude-status`, `claude-hook`, `codex-rollout`, `codex-hook`, `pi-session`, `none`), `stateAt` is when the state last changed (null while unknown), `stateDetail` says why it is blocked, and `statePrevious` is the state before (so `working` → `idle` is a finished turn, while `unknown` → `idle` is an agent Tether only just found). A change publishes `session.updated`. See [agent-state.md](agent-state.md).

`stateAgentAt` (12) is the agent's own time of its latest state (Claude Code's `statusUpdatedAt`, the Codex turn line, the Pi message; Tether's clock when the agent gives none), null until Tether has seen the agent's state; it keeps its last value after the agent leaves. It only moves forward, and a later one while `idle` publishes `session.updated`: a turn ended, even one shorter than the poll. `waitingOn` (12) is null, or names what the session itself waits on: an armed [wait](#waits) (`a wait on session "Store lane" (finished)`, 13), else its own pending check-in (`a check-in at 5:30 PM`, `a check-in that is due`), so a lane waiting on something is not taken for finished. `launched` (12) is true when the session's lineage came from a launch (`launchedBy`, a kept wake's relaunch, the hub's `lineage`), false for an owner's mark or join and for sessions from before v12. See [Lane reports](#lane-reports). `modelSwitch` *(22)* is null, or the session's current model switch: `{key, kind, from, to, category, at, stopped, commit, worktreeChanged, checked, rewindTo}` ([Model switches](#model-switches)).

`wakes` *(post-cutover)* lists the session's scheduled check-ins, oldest first; see [Wakes](#wakes).

`host` (8) is null for a session on this computer and names the remote host for one the hub federates; `peer` (8) appears only while that host's link is not live. See [Remote hosts](#remote-hosts).

## Sessions

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/sessions` | none; query `project`, `origin`, `tool` | `{items: Descriptor[]}` from the catalog, with status from the last verification. A session whose current generation has never been verified (a fresh root or replacement) is verified first, so the list agrees with `GET /v1/sessions/:id` *(post-cutover)*. |
| `POST /v1/sessions` | `{tool?, projectId?, projectRoot?, blankSlate?, instructions?, name?, origin, aTermSessionId?, size: {cols, rows}, host?, continueFrom?}` | `201` running or `202` pending/uncertain descriptor. A `202` also carries `failure: {code, reason} \| null` (`workload_unavailable`, `outcome_uncertain`). `origin` is `aico`, `a-term` or `cli`; `aTermSessionId` (a UUID) is accepted only with `a-term`. `projectRoot` follows the `POST /v1/roots` path rule (absolute, normalized: no `.`/`..` segments or repeated `/`, no NUL; otherwise `400 invalid_body` with `field: projectRoot`) and must be an existing directory (`400 unknown_project`). With both `projectId` and `projectRoot`, the root is used as given and is not compared with the project's registered root. `host` (8) creates on a remote host ([Remote hosts](#remote-hosts)). `continueFrom` (an 8-hex session id, with `tool`; this host only) starts the session in the old session's checkout (project and name unless given) with a recap as its first prompt: the old session's first request, its last messages from the tool's transcript and `git status` plus recent commits. Sizes come from `src/continue-recap.json` (`maxBytes` stays under the 14 KiB launch prompt limit). `404 unknown_session`, `400 continue_needs_project` (the old session has no checkout). Nothing is read from or changed in the old session beyond that. |
| `GET /v1/sessions/:id` | none | live-verified descriptor, plus `resumeId`: the native conversation ID of a Claude Code or Codex session as the continuity observer last saw it (every minute), else `null`. Rechecks the generation after the async verification and returns `409 identity_changed` if it moved. |
| `PATCH /v1/sessions/:id` | `{generation, name}` | rename. `name: null` clears to the default label. The label follows the root title rules (trimmed, 1–160 UTF-8 bytes, no control characters). |
| `POST /v1/sessions/:id/end` | `{generation, keepWakes?, endedBy?}` | `200 {status:"ended", keptWakes, keptWaits}`. Exact containment retirement: stops only the owned pane scope and uses `cgroup.kill` fallback. End cancels the session's wakes; `keepWakes: true` *(apiVersion 3)* keeps them, and they relaunch the conversation when due (see [Wakes](#wakes)); it keeps the session's armed [waits](#waits) too. `endedBy` *(apiVersion 21)* (8 hex) names the session asking for the End; it gets no lane `ended` line for it, and its own armed waits on the session are cancelled with their queued lines withdrawn ([Lane reports](#lane-reports)). For a session on another host the asker goes in the `Tether-Ended-By` header *(apiVersion 23)* instead: the hub keeps it for that lane's relayed `ended` and forwards the body as is. |
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

### Seen, and the waiting notice

`POST /v1/sessions/seen` `{ "ids": ["abcd1234", ...] }` (up to 50 session ids) → `{ "seenAt": <ms> }`.
Aico web sends it when the owner has sessions open and visible (an agent's automated browser never does).

The Tether that knows where Aico is (`TETHER_AICO_URL`) tells the owner when something waits on them: a
session `blocked` (a permission prompt or a question), local or on a remote host, not seen for the confirm window (`TETHER_WAIT_NOTICE_SEC`, default 120 s) since its wait began, gets one notice through Aico's notify (contract
v1 posted to `POST /api/notices` on loopback at `AICO_WEB_URL`, default `http://127.0.0.1:3002`; `kind: alert`,
`push: phone` with `interrupt: needs-you`, so an unattended stuck agent reaches the phone; the session itself is already in Needs you, so the notice files no ask of its own; Open as the one action:
`<aico>/?session=<id>`, a run's page only on Aico's origin). A repeat for the same key stays quiet for the
notice cooldown (an hour). The key is `aico-waiting:<session id>`. Tether posts
`POST /api/notices/resolve` `{source: "aico", key, text}` once it no longer waits: answered, seen, ended or
gone from the run list. A session on a remote host that has an Aico of its own (`sync` in hosts.json, a standby hub) is left to that host's Tether, so one session sends one notice. A model-switch notice (`aico-model:...`, a `todo`) goes the same way to the tray. Seen marks and open notices are
kept in the `waiting_notices` setting, so a restart neither repeats nor strands one.

### Session files

A front end's file browser reads a session's folder (its `projectRoot`) on the machine the session runs on, so the hub forwards these routes to the host of a remote session ([Remote hosts](#remote-hosts): routing) and a host that is not connected answers `409 host_unavailable`. Reads follow the web app's browser rules (`src/files/browser.ts`): one directory level or one file, never outside the folder, never a secret (`.env*`, `.git`, keys, `auth.json`, ...), hidden and build directories left out of listings, text files over 1 MiB truncated.

| Route | Answer |
| --- | --- |
| `GET /v1/sessions/:id/files/tree` | query `path` (relative, optional). `200 {entries: [{name, path, is_directory, size?, extension?, children_count?}], path, total}`. |
| `GET /v1/sessions/:id/files/content` | query `path` (required, else `400 invalid_query`). `200 {path, name, content, size, lines, extension, is_binary, language, truncated}`; `content` is null for a binary file. |

Refusals carry the reason in `detail`: `403 access_denied`, `400 invalid_path`, `404 no_such_file`, `409 no_folder` (the session has no folder, or it is gone); an unknown session is `404 not_found`. A host whose Tether predates these routes answers `404 not_found` without `detail`.

## Owner handoffs *(post-cutover)*

| Method and route | Body | Result |
| --- | --- | --- |
| `POST /v1/show` | `{session?, title?, url?, path?, paths?}`; exactly one of `url`, `path` and `paths` (absolute, existing files or folders, up to 20) | `201 {id, session, title, createdAt, kind: 'files', paths}` (real paths; a folder ends in `/`; nothing copied) or `{…, kind: 'url', url}`, and a `show.requested` event with the same data. |
| `GET /v1/shares` | — | `200 {items}`: the newest 200 shares, oldest first, kept for `TETHER_SHARE_RETENTION_DAYS` (default 30). |
| `DELETE /v1/shares/:id` | — | `200 {id, removed: true}`; `404 not_found` for an unknown (or already removed) ID. This Tether's own shares only: a linked host's share is removed on that host. An ask that pointed at it shows no attached files. Additive, no `apiVersion` bump. `tether share remove ID...` calls it per ID. |

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
| `POST /v1/sessions/:id/inject` | `{generation, text, mode: "type" \| "paste", submit?: bool, model?: string \| null, thinkingLevel?: string \| null}` | `{generation, delivered: true}`. `from` *(13)*, the sending session's id, records the send so a [wait](#waits) that session sets on this one counts turns from it |
| `GET /v1/sessions/:id/pane-mode` *(post-cutover)* | none | `{generation, alternateScreen, mouseReporting, historySize, inMode, mode}`: whether the pane shows its alternate screen, whether the program asked for mouse reporting, the history line count, and whether tmux shows a mode over the pane (`mode` is its name, such as `copy-mode`, else null). Read-only `display-message`. `409 workload_unavailable` when tmux cannot answer. |

Attach `env` holds **overrides only**, not a full environment: set exactly `TERM=xterm-256color`, `COLORTERM=truecolor` and `CLICOLOR=1` over the client's own environment, then remove every key in `unset` (`TMUX`, `TMUX_PANE`, `TMUX_TMPDIR`, `NO_COLOR`). Both lists may grow additively.

`mode: "type"` sends `send-keys -l`. `mode: "paste"` sends one bracketed-paste event; with `submit: true` it is followed by one Enter. Text must pass Aico's `isBoundedTerminalText` rule: nonblank, at most 2000 UTF-8 bytes, and no control characters except tab and newline. Injection is framing only. A `delivered` result does not mean the agent accepted the text, and it does not rule out a concurrent human draft. Injection is refused for non-`running` sessions.

### Active-client resize claim

When a view becomes active, it claims the shared tmux window size:

`POST /v1/sessions/:id/resize-claim` with body `{generation, clientPid, cols, rows, viewer?}` returns `200 {applied: true, changed}` or `{applied: false, reason}`. `changed` is true when the window's size differed before the claim, so a view that took the size back knows to repaint. A successful claim also moves the foreground pane's `MemoryLow=2G` to this session's pane scope, since Aico claims the size when a view gains focus.

`POST /v1/sessions/:id/show` is retired: Aico has no desktop windows, so it answers `410 windows_retired` and nothing happens. A session shows in Aico web.

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

A stale or wrong-workload `generation` is refused before the claim with `409 stale_generation` / `409 workload_unavailable`. A successful claim records the claiming client as the session's **size holder** (the client the shared window now fits; any other attached client sees the window at a size that is not its own) and publishes `session.resized` with `{id, generation, clientPid, cols, rows, changed, viewer}`. A client compares `clientPid` with its own attached client's pid to learn it no longer holds the size. `GET /v1/sessions/:id/resize-claim` returns `{generation, holder}`, where `holder` is `{clientPid, cols, rows, generation, claimedAt, viewer}` or `null` when unknown (no claim yet on this generation). Tether saves the holder in its settings, so a restart keeps it; a holder whose session is no longer listed is dropped at start. Whether the holder's tmux client is still attached is the viewer's check, as before. `viewer` is `null` when the claimer sent none. Desktop auto-resize on active-client change is intended behavior. The web app claims only when its view becomes active, not on every resize.

## Roots

A root is a session created through the root contract with a stable caller `requestId`. The [root contract](../../../docs/root-control.md) (moved from Aico at the cutover) holds the digest, tombstones, the resume adapters and every validation rule. Mutations serialize on the session identity and share one handler with the widget routes.

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/roots` | query `origin=aico\|a-term` *(3a)*, `ended=0\|1` *(post-cutover)* | `{owner, available, directedDelivery, roots: Descriptor[]}`. `owner` is the `origin` filter, else `"aico"`. `ended=0` leaves out ended tombstones (they stay readable at `GET /v1/roots/:requestId`). `400 invalid_query` for another origin or `ended` value. |
| `POST /v1/roots` | `{requestId, tool, projectId, projectRoot, initialPrompt, role, leadRootReference?, facetCapsuleRef?, resumeSessionId?, model?, origin?, aTermSessionId?, launchedBy?, lineage?, host?, needs?, pool?, entry?}` | Existing or reserved root descriptor. `host` and `lineage` (8): see [Remote hosts](#remote-hosts); `host: "auto"` with `needs` (10), `pool` (11), `needs` with a named `host` (14) and `409 at_capacity`: see Placement there. For a tool that can list its models (Pi), a `model` it does not list is `422 unknown_model` with `reason` naming the host and the listing command, before anything is reserved; a create with `host` gets the same `400` answers as a local one for a malformed option before the hub wakes the host, and the host's Tether judges the model. The descriptor's `agentExit` (`{status}` or `{signal}`, else `null`) says how the root's agent ended while its session stays at the shell. `200` for running or ended, `202` for pending or uncertain. `400 unsupported_tool` with `supported: slug[]` for a tool that can't start a root (`rootCapable: false`). `400 prompt_too_long` with `limit` when `initialPrompt` exceeds 14 KiB fresh or 2000 bytes on resume ([root-control.md](../../../docs/root-control.md)). `409 request_conflict` if the same key arrives with a different digest. `409 recovery_pending` with `widgetId` when a new request's `resumeSessionId` is a conversation that [crash recovery](crash-recovery.md) is about to resume, or holds, in that session. |
| `GET /v1/roots/:requestId` | none | Current descriptor, including ended tombstones (`status: "ended"`, `generation: null`). Every root descriptor carries `launch`: null, or `{state: "deferred", reason, checkedAt, nextRetryAt, attempts}` while host admission holds a pending launch back. Tether tries it again every 30 s, the same way as repeating the create, until it starts or the root ends. The record lives in memory, so a Tether restart drops it; repeat the create then. |
| `POST /v1/roots/:requestId/show`, `POST /v1/roots/:requestId/position` | any | Retired: `410 windows_retired`, nothing applied |
| `POST /v1/roots/:requestId/title` | `{generation, label}` | Renames the session in Tether |
| `POST /v1/roots/:requestId/end` | `{generation}` | Same as session End. The tombstone is retained. |
| `POST /v1/roots/:requestId/send` | none | `503 directed_delivery_unavailable` |
| `GET` and `POST /v1/roots/:requestId/admin` | as in Aico | Generation-checked, fail-closed `503`. No terminal input. |
| `GET /v1/widgets/:id` | none | Compact descriptor `{owner:"aico", widgetId, sessionId, generation, status, available}` |
| `POST /v1/widgets/:id/title` | `{generation, label}` | As for roots |
| `POST /v1/widgets/:id/show`, `POST /v1/widgets/:id/position` | any | Retired: `410 windows_retired`, as for roots |
| `POST /v1/widgets/:id/coordinator` | `{generation, coordinator: boolean \| widgetId}` | Marks, unmarks or joins a coordinator in the catalog (see [Coordinators](#coordinators)) |

**Entry** *(15)*. `entry: {name, arg}` runs the root's agent through a program on the host that runs it, on every launch: the first, a restart, crash recovery and reboot restore. `name` must be a key of that host's `~/.config/tether/entries.json` (`$XDG_CONFIG_HOME/tether/entries.json`, or `$TETHER_ENTRIES_FILE`), `{"<name>": {"argv": ["/abs/program", ...], "home": "~/path/{arg}/home"}}`; `arg` matches `^[a-z0-9][a-z0-9-]{0,79}$`. The pane runs `/usr/bin/env TETHER_ENTRY_HOME=<home> <argv> <arg> -- /bin/sh -c '<launch line>'`; the launch line is the one a normal root runs, with its `AICO_ROOT_*` and `ST_*` variables left to the entry to pass on. Tether passes the entry nothing else (no socket, no path), so what reaches inside is the entry's choice. `home` (`{arg}` filled in, `~/` this host's home) is where the host sees the agent's home: Tether reads the agent's state, resume id and transcript there ([agent-state.md](agent-state.md)), because its pid is not the pane's and its hooks cannot reach Tether. Only `claude-code` (and from 19 `codex`) takes an entry, and not with `instructions` (`400 invalid_body` with `field: "entry"` and `reason`, as for a malformed entry). A name the host does not list is `400 unknown_entry {entry, reason}`; a listed one that is malformed is `422 entry_unavailable {entry, reason}`; nothing is reserved either way. `entry` is part of the digest and kept on the session (the descriptor carries `entry`); it goes with the session at End, and a kept wake or wait never starts such a session again. If the entry later leaves entries.json, a launch prints why and exits 78 instead of running the agent on the host. With `host`, the hub sends `entry` only to a host at API 15 or later (else `400 entry_unsupported {host, reason}`, nothing sent); the host's own entries.json decides the name.

**Codex entry** *(19)*. `tool: "codex"` takes `entry` as `claude-code` does, with the same errors, digest, End and fail-closed launch. The pane line also carries `TETHER_ENTRY_TOOL=<tool>` (`claude-code` or `codex`) next to `TETHER_ENTRY_HOME`, so state is read the way that agent writes it; an entry process without the marker is `claude-code` (launched before 19), and one naming another tool is read as nothing. Tether reads Codex's state, thread id and turn from `<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` ([agent-state.md](agent-state.md)), never from this host's `~/.codex` or a rollout a pane process holds open, so the agent's `CODEX_HOME` inside must be `<home>/.codex` as the host sees it. An explicit `model`, `reasoningEffort` and `daybreak` reach Codex through the launch line's `AICO_ROOT_*` variables, as for Claude, so the entry must pass `AICO_ROOT_*` on; a resume (restart, crash recovery, reboot restore) runs `codex resume <thread>` through the entry against that same home. A session whose stored tool is one no entry runs launches nothing (prints why, exits 78). `st aico create --tool codex --entry NAME:ARG` sends it and skips this computer's Codex catalog checks (`--model`, Daybreak), since the entry's Codex has its own login and catalog; the host's `/v1/tools` must still list `codex` as root-capable. Creating it never reads, copies or forwards a Codex login; how the agent inside reaches a model is the entry's. With `host`, the hub sends a `codex` root's `entry` only to a host at API 19 or later; a host at 15-18 runs Claude entries only and gets `400 entry_unsupported {host, reason}` with nothing sent and nothing run on any host.

**Pi entry** *(20)*. `tool: "pi"` takes `entry` as `claude-code` and `codex` do, with the same errors, digest, End and fail-closed launch, and `TETHER_ENTRY_TOOL=pi`. Pi keeps no record Tether could find inside, so the host picks the conversation id: every launch of a Pi root carries a new `AICO_ROOT_FRESH_SESSION_ID` (a UUID; empty for other tools), and the launch line starts Pi with `--session-id` set to it, or with `--session <id>` when the launch resumes `AICO_ROOT_RESUME_SESSION_ID`; both variables are unset again in Pi's own environment (it sees `TETHER_AGENT_SESSION_ID`). The entry must pass `AICO_ROOT_*` on, as for Codex. Tether reads the id back from the entry process's environment (the resume id on an initial launch that resumes, else the fresh id), then Pi's state from `<home>/.pi/agent/sessions/<cwd dir>/<time>_<id>.jsonl` matched by that exact id ([agent-state.md](agent-state.md)); it never picks another file, never reads this host's `~/.pi`, and the id is resumable once that file exists. An explicit `model` (`provider/model`, e.g. `opencode-go/deepseek-v4.1-flash` or `opencode-go/glm-5.3-flash`), and `reasoningEffort` reach Pi through `AICO_ROOT_*` and are kept for every later launch. A Pi root's restart with nothing to resume (entry or not) starts the new conversation under the launch's fresh id too. `st aico create --tool pi --entry NAME:ARG` skips this computer's Pi provider check (the entry's Pi has its own); Tether's host model list is not asked for an entry. With `host`, the hub sends a `pi` root's `entry` only to a host at API 20 or later; a host at 15-19 gets `400 entry_unsupported {host, reason}`, nothing sent and nothing run.

**Claude Code model and effort.** `model` and `reasoningEffort` (`low`, `medium`, `high`, `xhigh`, `max`) are accepted for `tool: "claude-code"` too, as for Codex: the launch line adds Claude Code's `--model` and `--effort` before `--resume` and the prompt, and they are kept for every later launch. `daybreak` is still refused for it. No wire change.

**Kept launch options** *(schema 23)*. A root's explicit `model`, `reasoningEffort`, and `daybreak` are stored with its reservation (`session_launch_options`, dropped with the session), so every later launch of its agent (crash recovery, restart or respawn, a wake, reboot restore, with or without an entry) gets the same `AICO_ROOT_*` values and adapter flags as the create did, and never the prompt again. A root created without them, or before schema 23, relaunches as before. No wire change. `st aico create --entry` first reads `/v1/version` and refuses (nothing sent) when this computer's Tether is below API 15 for Claude Code, 19 for Codex or 20 for Pi.

**Entry home containment.** Tether's host-side reads of an entry home (Claude session files, Codex rollouts and the rollout it tails, Pi session files and the one it tails, crash-recovery transcripts) open each file without following a last-component symlink and without blocking on a FIFO, then check that the open descriptor is a regular file (or directory, listed through that descriptor) inside the home before reading a byte; a tailed rollout is reopened and checked on every read. A link or a replaced path that leads outside the home reads as nothing, and a home that is itself a symlink is not read at all. Each read lists at most `TETHER_ENTRY_ROLLOUT_SCAN` rollouts (default 2000) and opens the newest `TETHER_ENTRY_ROLLOUT_OPEN` (default 32); either set to anything but a whole number from 1 refuses daemon startup.

The root descriptor keeps Aico's fields: `owner`, `hostIdentity`, `generation`, `logicalSessionId`, `surfaceLocator`, metadata, `bounds` and `status`. `bounds` is always `null`: Aico has no desktop windows.

Root origin *(3a)*: `origin` is `"aico"` (default) or `"a-term"`; `aTermSessionId` (a UUID) is accepted only with `"a-term"` and becomes the pane's `A_TERM_SESSION_ID`. Neither is part of the request digest. A root's `owner` is its stored origin and the descriptor also carries `origin`. The pre-Tether sockets `/run/user/<uid>/aico/control.sock` and `gui-control.sock` were removed on 2026-10-24; `st aico` and SummitFlow fleet use this socket.

A new root is visible in Aico web as soon as it runs. Tether opens nothing on a desktop.

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
- `parentId` *(9)* is the session that launched this one: the root coordinator, or a lane of it that started its own helper. It is null on coordinators and on sessions launched before it was recorded, and it may name a session on another host. Colour, tiling, routing and root control follow `coordinatorId`; only the lists nest by `parentId`: a session folds under its parent while that parent is listed, else under its coordinator, as before. A manual `join` makes the named session the parent. A kept wake relaunches under the same parent while that parent is still a lane of the same coordinator.
- `coordinatorColor` is the coordinator's colour, `#rrggbb` from a fixed palette of eight, on the coordinator and on each of its lanes. A new coordinator takes the first colour no other coordinator holds, so coordinators on screen together differ until there are more than eight. Lanes keep their colour after the coordinator ends.
- When a coordinator ends, each running lane of it that was created with work role `coordinator` becomes a coordinator itself (as `coordinator: true` would), and the lanes it launched move under it, keeping their parents; every other lane keeps the ended coordinator. While the coordinator runs, a coordinator-role lane stays its lane.
- `POST /v1/widgets/:id/coordinator` marks or unmarks one by hand (`st aico widget coordinator on|off`), and publishes `session.updated`. Unmarking frees the colour; lanes keep theirs.
- `coordinator: "<widgetId>"` (`st aico widget coordinator join <widgetId>`) makes the session a lane of that session's root coordinator, marking it a coordinator if it is not one or a lane already. The session stops being a coordinator and its own lanes move with it. This repairs sessions that predate `launchedBy` and were promoted when they launched helpers.

### Transfer a running lane (API 29)

`POST /v1/sessions/:id/transfer` takes exactly
`{generation, coordinatorId, coordinatorGeneration, fromCoordinatorId}`. Both generations are
64-character lowercase hex fences; both coordinator IDs are eight-character session IDs.
The lane must be running, already linked and `launched`; the destination must be a running,
top-level coordinator on the same Tether. It never promotes a destination implicitly.

Tether holds lifecycle ownership of the destination, lane and every descendant, verifies the
two runtimes, then changes the catalog and existing open asks in one transaction. The lane's
`parentId` and `coordinatorId` become the destination; descendants take its coordinator and
colour while keeping their parents and `launched` flags. Other lanes and explicit report
watches keep their routing. Queued automatic reports to a former receiver are withdrawn when
the new descriptor is observed; a report already delivered or being sent cannot be recalled.
Report cursors remain intact, so a transfer does not replay old turns. Open questions keep their
IDs and move their launch/fallback lineage. A filed notice still queued for the former launcher moves to the new
one; a notice already delivered is not sent again, and a retry that changes no launcher sends nothing. Already answered asks keep
their delivery history; future questions read the new lineage.

The response is the running session descriptor plus `transferred: string[]` (lane first).
`409 stale_generation`, `workload_unavailable`, `busy`, `lane_not_linked`,
`not_top_level_coordinator` or `lineage_changed` applies nothing. An unknown session is `404`.
A repeat against the same running generations and destination is safe after a lost response.
No root request, entry, launch options, native conversation, tmux identity, container or placement
booking is replaced; no runtime launch, end, respawn or injection operation is called.

```sh
st aico widget coordinator transfer NEW_SESSION --widget-id LANE_SESSION --from OLD_COORDINATOR
```

`join` retains its manual grouping contract, which clears launched reporting. Use `transfer`
for a linked lane. For a Neri hunt, use `st neri hunt transfer CASE --to NEW_SESSION --from
OLD_COORDINATOR --json` so Neri updates its stored coordinator and egress route too. Calling
the Tether operation alone cannot update another application's records. Remote coordinator
transfers and transferring an entire top-level coordinator are not supported by this operation.

### Display title and badge

Tether names every session once, and the desktop, the web app and `st` show these fields as they are, without composing their own.

- `displayTitle` is `Project — Task`: the project's name from the project list (Aico's Personal Workspace root is "Personal Workspace") and the session's `name` (an unnamed root uses its `--work-role-name`, else its request ID). Either one alone when the other is missing or the task only repeats the project; `Session <n>` when both are missing.
- `badge` is `{kind, text, color}` or null. A coordinator has `{kind: "coordinator", text: "Coordinator"}`. A session it launched has `{kind: "child", text: "↳ <coordinator>"}`, naming the root coordinator by its task, else its project, else "Coordinator" (ended). `color` is `coordinatorColor`, or `#6fa8ff` for sessions from before colours.
- A rename, a project switch or a changed project name publishes `session.updated` for the session. A renamed coordinator also publishes its lanes, whose badge text changed. Tether rereads project names every five minutes.

### Retired desktop windows

Aico has no desktop windows, so Tether has no GUI channel. `title` and `coordinator` change the catalog directly: `title` renames the session under the lifecycle lock, fenced on the exact running generation, and publishes `session.updated`; `coordinator` changes the catalog mark. `show` and `position` (the session, root and widget routes above) answer `410 windows_retired` and apply nothing, and so does any request to the old desktop client's routes (its channel, results and layout, all under the `gui` path prefix). `st aico layout`, `st aico widget position`, `st aico root position` and `st aico root show` print "Aico has no desktop windows any more; sessions show in Aico web. Nothing to arrange or show." and exit 2. `GET /v1/health` no longer reports `gui`, and the events `gui.connected` and `gui.disconnected` are gone.

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
- `rootCapable` is read-only and derived: true exactly when the tool has a resume adapter, because a root must be resumable after a crash. Only those tools can start a root ([root contract](../../../docs/root-control.md#create)).
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

`activeProjectId` and `current` *(post-cutover)* name st's persisted active project (`st projects active`), read from its pointer file `~/.local/share/st/active-project.json` on every request. It is null, and every `current` false, when the file is absent or malformed or names a project that is not listed. `TETHER_ACTIVE_PROJECT_FILE` overrides the path; `off` ignores it. Changing the pointer publishes no event.

`source` is one of:

- `registry`: the projects registry (`aico projects`, `tasks.db`), read on every call and cached for 30 s, once it has projects. Retired projects are excluded. It is the source whenever it has projects, so `POST /v1/projects` answers `409 projects_managed_by_registry`: use `aico projects register`.
- `local`: the registry has no projects or cannot be read. The list comes from `~/.config/tether/projects.json`, a list of `{id, name?, root}`; entries whose roots are not directories are skipped.

`refresh=1` re-reads `projects.json` in local mode.

`POST /v1/projects` *(3a)* with `{id, root, name?}` registers a project in local mode: it appends to `projects.json` atomically (temp file and rename, mode 0600), refreshes the list, returns `201 {id, name, root, lifecycle: null}` and publishes `projects.changed`. Errors: `400 invalid_project_id` (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`), `400 invalid_project_root` (not an absolute directory), `409 project_exists`, `409 local_projects_unreadable`, and `409 projects_managed_by_registry` when the source is the registry.

## Asks *(post-cutover)*

An ask is a question an agent puts to the owner once, in Aico's Needs you
drawer, with the answer coming back to the agent. Agents use `tether ask`
(below), so any harness can ask through its shell.

| Method and route | Body | Result |
| --- | --- | --- |
| `POST /v1/asks` | `{session?, requester?, question, options?, recommended?, body?, command?, open?, origin?, share?, attach?, files?, blocking?}` | `201` a new ask, or `200` the asker's existing ask with the same question: an open one takes the new fields, an answered one comes back unchanged so the asker reads the answer. |
| `GET /v1/asks?session=&requester=&state=open,answered` | — | `200 {items}`: up to 200, most recently changed first. |
| `GET /v1/asks/:id` | — | `200` the ask. |
| `POST /v1/asks/:id/answer` | `{option?, text?, note?, files?}`: a choice's index or a one-line text (not both), and/or a note, and/or `files` (below) | `200` the ask, `answered`. `409 ask_closed` once done or withdrawn. `400 files_not_requested` for files on an ask that wanted none. Answering again replaces the answer and the files. |
| `POST /v1/asks/:id/done` | — | `200`, state `done` (the agent acted on it). |
| `POST /v1/asks/:id/withdraw` | — | `200`, state `withdrawn` (the question no longer applies). |

The ask: `{id, session, requester, question, options, recommended, body,
command, open, origin, share, attached, wantsFiles, files, blocking, state, answer, note, delivery, launcher, answerTo,
createdAt, updatedAt, answeredAt}` (times in ms). `session` is the asking session's ID (the pane's
`AICO_WIDGET_ID`); without one, `requester` (one line, at most 60 characters)
names the asker. `question` is one line of at most 200 characters that stands
alone; `options` up to 5 one-line choices of at most 100 characters,
`recommended` the index of one. `body` (4000) and `command` (2000) may span
lines. `open` is one https link (300) the card opens. `origin` is `notice` or `status` when an app filed the ask (a notice that asks something, a failed Status row), else null: the card has no agent to reply to. `share` is a `tether share` ID. `blocking` says the agent stopped and
waits: the owner's app marks the session as needing them and pushes once.
`state` is `open`, `answered`, `done` or `withdrawn`. One ask per asker and
question while it is open or answered (question compared without case or
extra spaces). Done and withdrawn asks go after `TETHER_SHARE_RETENTION_DAYS`.

**Asks that want files** (API 26, schema 30). `files: {min, max, hint}` on
create: `min` 0 to 20, `max` 1 to 20 and at least `min`, `hint` one line of at
most 100 characters or null. The ask shows it as `wantsFiles` (null when it
wants none). The answer's `files` is a list of `{id, name, mime, size, path,
host}` (`id` 12 hex: a capture in Aico, read with `tether capture get ID`;
`path` the file on `host`, or null), at most `max`. Tether checks shapes, not
content, and not `min`: an owner can answer without files. The ask then
carries them as `files` (empty until a files answer), and the answer's event
line adds `files: 2 (ids …; read: tether capture get ID)` before its tail.
Asking the same open question again updates `wantsFiles` with the rest.

**Attached files** (API 32). `attach` on create: 1 to 20 absolute paths of
files or folders for the owner to look at (`tether ask create --file`). Each
must exist and be readable (`400 invalid_path` otherwise); Tether links them as
a share titled with the question, as `POST /v1/show` does (nothing copied;
the session's existing share with exactly those paths is reused), and sets
`share`. `attach` and `share` together are refused. Every ask response carries
`attached`: the share's paths as they are on disk now, `{path, name, kind,
size}` with `kind` `file`, `folder` or `missing` (moved, deleted or
unreadable) and `size` in bytes for a file, else null; empty without a files
share.

**The answer reaches the agent.** On an answer, Tether queues an event line
(source `ask:<id>`) on the session the answer goes to (`answerTo`, below;
delivered when the agent is idle, its input line empty and the owner quiet),
which carries the question and the answer within `noteMaxChars` and ends with
`tether ask get <id>` and `tether ask done <id>`. `delivery` is then `wake`.
The line is queued even while Tether has not read the agent's state yet (just
restarted). It is also taken by the session's next natural turn (a prompt, a
tool result: the ride-along path, `GET …/due?ride=`) while the agent stays busy,
so an agent that never shows idle (Claude Code counts its background agents as
busy) still gets it. It is dropped undelivered only when its ask is answered
again, done or withdrawn, and Tether logs that with the line's age.

**Asks from ended lanes** (API 17). `launcher` is the session that launched
the asker and `coordinator` its coordinator (lineage from a launch, recorded
when the ask is filed); `answerTo` is where the answer goes: while open, the
asker while it is there (even while its state is unknown), else its launcher,
else its coordinator, else null (worked out when the answer comes); once
answered, where it went. A launcher on another host is not reached: the card
then says no session gets it. The ask card in Aico says which session gets it. A
lane that files an ask sends its launcher one line (source `ask:<id>:filed`):
`[Ask] session "Disk merge" (0123abcd) asked the owner (<id>): "…" · relay or
close it, don't ask again: tether ask get <id>`. A session that ends with open
asks hands them to its launcher in one line (`[Asks handed over] session … ended
with 2 open asks to the owner (…); the answers come to you · …`), never a
silent orphan. A launcher that ends hands on the asks it holds the same way
(their `launcher` becomes the coordinator), and an answer already queued to a
session that ends before it goes out is queued again to the next session up.
A session Tether cannot wake (it has ended, it is a shell, or its agent's state
is unknown) gets `delivery: "pull"`: the agent reads the
answer with `tether ask get` or `tether ask list --mine`. Claude Code, Codex,
Pi and Antigravity sessions are woken. Done, withdraw and a new answer cancel a
check-in that has not gone out yet.

**Session descriptor.** `asks`: the session's open asks, oldest first,
`[{id, question, blocking, createdAt}]`. A blocking one marks the session as
needing the owner in the apps, whatever state its agent reports.

**Events.** `asks.changed` `{ask, created}` on every create, update, answer
and close. Not relayed from remote hosts; asks stay on the asking session's
own Tether.

**Tray feed.** The daemon keeps `<stateDir>/needs-you.json` (0600, written
atomically) for the Aico tray: `{version: 1, writtenAt, open, blocking,
newest: null | {id, name, blocking, createdAt, url}}`, where `name` is the
session's title or the requester and `url` is Aico's link to the ask
(`TETHER_AICO_URL` + `/?ask=<id>`, null when that is unset). It never holds the question. It is rewritten on every
change, at startup and every 60 s, so a `writtenAt` older than a few minutes
means Tether is not running.

`tether ask create "<question>" [--option T]... [--recommend N] [--blocking]
[--body T | --body-file P] [--command C] [--share ID] [--session ID | --from L]`,
`tether ask get|done|withdraw <id>` and `tether ask list [--mine] [--all]`
(`tether ask --help`). There is no blocking wait: the answer arrives as a
message.

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
- `wakes.changed` (`{sessionId}`; null for a kept wake of an ended session)
- `asks.changed` (`{ask, created}`): see [Asks](#asks-post-cutover)
- `peer.state` (8, `{host, state, since}`) and `peer.resync` (8, `{host}`): see [Remote hosts](#remote-hosts)

A remote host's relayed events carry `data.host` (and `host` on `data.session`); this computer's own events have no `data.host`.

`session.created` and `session.updated` carry `session` *(post-cutover)*: the session descriptor as `GET /v1/sessions` would list it, with a status verified for the exact generation the event announces. Clients can apply it instead of fetching the descriptor; one that sees no `session` (an older Tether) re-reads. Session events are published in order through one queue. `session.ended` carries the ID (and generation) only; `session.resized` adds the size holder as above.

Events never carry terminal contents or prompts. A `session` snapshot carries the session's name and label, which every `GET /v1/sessions` caller on the same socket can read anyway.

SSE was rejected. NDJSON is simpler to consume from both Node and Python (`httpx` line streaming) over a Unix socket, and browsers never connect to Tether directly.

## Memory policy

Tether owns the agent-pane memory policy: the pane cap and the kill policy for runaway agent tool jobs. Host memory
(the host's pressure state in host-steward's `admission.json`, swap, systemd-oomd, the app.slice cap) stays with
host-steward. The web app's settings panel edits it. The guard acts on `memory_state` (memory alone) when the file
has it, else `state`: since 2026-10-31 the `state` is the worse of memory and disk, and a full disk is no
reason to warn about memory or kill a tool job. The other readers keep `state`/`admit`: placement on this computer
needs green (an amber or red disk closes it), agent launches and `wait cmd` starts close on red, and automatic crash
recovery waits on memory amber or anything red but not on a disk-only amber (`memory_state` green).

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
runtime is kept. The guard (`packages/session-engine/src/lifecycle/job-guard.ts`) never kills a pane's root shell or its agent; it writes
`kill`, `warning` and `agent-hog` records with killer `tether` to host-steward's memory event record
(`~/.local/state/host-steward/memory-events.jsonl`, schema v1; `TETHER_MEMORY_EVENTS` names another absolute path, which
the agent user's unit uses to keep the record in its state dir where host-steward reads it) before acting, and its heartbeat
`$XDG_RUNTIME_DIR/tether/default/memory-guard.json` (`v, ts, pid, host_state, critical_since, last_kill_at,
kill_enabled, kill_candidate`) tells host-steward whether a job it may stop exists and that the guard is alive.

## Wakes *(post-cutover)*

A wake is a scheduled check-in on a session: a time and a short note. Agents set their own with `st aico wake`; the
owner sets and cancels them from the web app. Tether is the only scheduler, and the `wakes` table
survives Tether restarts and reboots. The design is in `docs/plans/session-wakes.md` at the repository root.

When a wake is due, Tether republishes it as due (`wakes.changed`) and waits until
the agent is `idle`, no attached client has sent a key for `quietSeconds`, and the agent's input line holds no draft.
It then pastes one line for all of the session's due wakes, oldest first, and submits it:
`[Scheduled check-in for 5:30 PM, 12 min late] check the lane reports`. [Lane report](#lane-reports) lines queued for
the session go first, joined with ` / `. One paste stays under 1800 bytes; rows that don't fit wait for the next paste
(a single oversized row is cut to fit), and no second paste goes to a session within `quietSeconds` of the last. Each wake goes out at most once. A wake that
was due while Tether or the host was down goes out when the gates next pass. Closing a view does not cancel a wake.
While a due wake waits, its `waitingFor` names the first gate it fails (`the agent is working (claude-status)`,
`someone typed in the last 15s`, `the input line holds a draft`, `the session is stopped`), and Tether logs each new
reason once (`[tether:wakes] delivery for session=… waits: …`) and how long it waited when it goes out. A Claude Code
session parked into a background job is read from the job's status file, not the pane process's frozen one.

End cancels the session's wakes unless the End request says `keepWakes: true`. A kept wake outlives the session: when
due, Tether starts a new session with the ended session's tool, project, name and coordinator lineage, resuming its
conversation when Tether saw its conversation ID (the message then adds `resumed after End`). If a running session
already holds that conversation, the wake moves to it instead. A relaunch the host refuses for now (admission, linger)
waits a minute and tries again; one that fails counts an attempt, and after `relaunchAttempts` the wake stays listed
with its `lastError` until the owner moves or cancels it.

Wakes need an agent whose state Tether reads (Claude Code, Codex, Pi) and currently knows. A shell, or an agent whose
state is `unknown` (Pi before its first prompt, an agent that left for the shell), is `409 wake_unsupported`.


| Route | Request | Response |
|---|---|---|
| `GET /v1/wakes` | | `{items, policy}`, every wake, soonest first |
| `GET /v1/sessions/:id/wakes` | | `{items, policy}` for one session |
| `POST /v1/sessions/:id/wakes` | `{dueAt, note, createdBy?}` | `201` the wake. `dueAt` is epoch ms, at most 5 minutes past and 366 days ahead; `note` is one line (line breaks become spaces) of at most `noteMaxChars`; `createdBy` is `agent` (default) or `owner`. `409 wake_unsupported`, `409 too_many_wakes {max}` |
| `PATCH /v1/wakes/:wakeId` | `{dueAt?, note?}` | `200` the wake; resets a kept wake's failed attempts |
| `DELETE /v1/wakes/:wakeId` | | `200 {deleted: true}` |
| `GET /v1/wake-policy` | | `{policy}` |
| `PUT /v1/wake-policy` | any subset of `policy` | `{policy}`; a bad field is `400 invalid_body` with `field` and `detail` |

The lists, the descriptor's `wakes`, `maxPerSession` and the wake routes cover check-ins only; lane report lines on
the same queue are not listed and cannot be patched or deleted (404).

A wake is `{id, sessionId, dueAt, note, createdAt, createdBy, kept, attempts, lastError, waitingFor}`; `waitingFor` is
null unless the wake is due and held. A kept wake whose session
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
| `laneSettleSeconds` | 12 | a lane must stay idle this long before `finished` goes out (0-300) |
| `laneBlockedSeconds` | 3 | a lane must stay blocked this long before `blocked` goes out (0-300) |
| `laneFinishedFloorSeconds` | 120 | at most one `finished` per lane in this long; later ones fold into the next (0-3600) |
| `laneRepeatQuietSeconds` | 600 | a repeat `finished` (no send or wait from its receiver since the last) needs the lane idle this long, doubling per repeat; 0 is off (0-3600) |
| `laneRepeatQuietMaxSeconds` | 1800 | the most quiet a repeat needs (0-14400) |

## Lane reports

A lane started with `st aico create` (or `POST /v1/roots` with `launchedBy`) tells whoever launched it when it
finishes a turn, is blocked on the user, or ends. Nobody subscribes and no check-in is scheduled. Each report is one
line on the receiver's delivery queue ([Wakes](#wakes)), pasted under the same gates:

`[Ready] lane "Store lane" (req neri-r1) went idle after 6m · st aico root status neri-r1`
`[Ready] lane "Store lane" on neri-vm is blocked: permission prompt · st aico widget status --widget-id 1a2b3c4d`
`[Ready] lane "Store lane" (req neri-r1) has no running agent; the session is still open · st aico root status neri-r1`
`[Ready] lane "Store lane" (req neri-r1) ended · st aico root status neri-r1`

The line carries the lane's title (control, bidi and zero-width characters, brackets, quotes, backticks and a leading
`/` or `!` removed, at most 60 characters), its host, its request id and the command that shows it; never the agent's
reply text. An undelivered line for the same lane and outcome is replaced by the newer one.

- **Who hears it**, worked out when the report fires from the lane's current lineage: every line goes to the lane's
  launcher, its `parentId` (the coordinator for an ordinary lane, the lane that started this helper). The root
  (`coordinatorId`) gets it only when it is the launcher, or in place of a launcher that is gone: ended, its agent
  exited (exit 0, or crash recovery holds it), or a session that can't take lines. A remote lane's launcher on that
  lane's own host (an agent session there) hears it from that host's Tether, so the root here gets nothing for it. A receiver that waits on
  the lane itself hears the event from its [wait](#waits) and gets no line, and nobody stands in for it: a session
  wait it armed as waiter, or from a `--block` client (*schema 27*, the request's `by`), that is still armed and
  fires on this event, or fired on it (at or after Tether here first saw the lane in that state, its own clock). A
  `--block` client counts while it is attached or asked within two long polls, and once fired only if it was given
  the line, so a client that died swallows nothing. `finished` is covered by a wait until `finished` (a turn after its `since`)
  or `idle`, `blocked` by one until `blocked`, `ended` by any (it fires `ended` or `gone`). The daemon log names
  each (`heard from its wait: <ids>`). A receiver must be a session on this computer that Tether can deliver to
  (Claude Code, Codex, Pi), never a shell. Only `launched` lineage counts: a lane an owner marked or
  joined reports nothing, and nothing is backfilled for sessions from before v12.
- **finished**: the lane is `idle` with a `stateAgentAt` later than the last one reported, held `laneSettleSeconds`.
  It catches turns too short for the poll and turns during a Tether restart; the per-lane cursor is kept in the
  database, so a restart never repeats one. A lane whose `waitingOn` is set is not finished. *(schema 29)* Its
  still-queued ride-along `reply` deliveries ([Deliveries](#deliveries)) to its receivers then become wakes, since no
  `finished` line goes out to carry them (a noted yes to its launcher, then a wait of its own armed). Log: `lane=<id>
  idle on its own wait: its ride-along reply wakes <ids>`. A lane launched
  while Tether runs counts every turn, its first included, even one that ended before the poll found the agent. A new
  generation (crash recovery, respawn, reboot restore), or a lane Tether first sees idle at its own start, resets the
  cursor without a report, and so does closing a dialog the owner opened (`/model`). At most one per
  `laneFinishedFloorSeconds`. *(schema 25)* A repeat, the next `finished` with no act from its receiver since the
  last, needs the lane to hold idle with no new turn `laneRepeatQuietSeconds`, doubling per repeat up to
  `laneRepeatQuietMaxSeconds` (defaults 10, 20, then 30 minutes): a lane waiting on its own work with short turns in
  between stays quiet, and one that stalls is heard within the cap. It starts over at the normal settle and floor
  when a receiver sends to the lane (`inject` with `from`, as `st aico root send` does) or arms a session wait on it,
  on a new generation, and after a `blocked` or `ended`. *(25)* A wake-class delivery to the lane with the receiver in `from`
  (a coordination request or ack, [Deliveries](#deliveries)) counts as a send; a ride-along one does not. It also
  starts over when something reaches the lane, counted when the lane gets it, not when it was sent: a line pasted
  into it or taken by it, an `inject` with `submit`, or its own `reply` delivery (ride-along too). *(schema 29)* A
  line counts only when it is wake class and came from outside the lane: a delivery whose `from` names another
  session, Tether's own `lane:`, `run:` or `ask:` line, or a check-in the owner set. A ride-along line (another
  lane's repeat, an FYI, a bare yes), a delivery with no other sender (the lane's own watcher: an eta reminder, a
  memory notice), its own `wait:` lines and an agent's check-in do not; a line merged into a queued one keeps the
  queued one's mark. So a request sent before the
  lane's last `finished` line but pasted after it still makes the next `finished` a wake. Log: `lane=<id> <why>:
  its next went-idle line is a first line`. When something reaches the lane while its last idle's line is still
  held, that line goes out as it would have and the idle after it is the first line, across a restart too
  (`lane_reports.reached_after`). The streak is kept in the cursor, so a restart keeps it
  (the quiet counts from the restart). Log: `lane=<id> idle again: repeat N goes out after Ns quiet`, once per idle.
  *(24, schema 28)* Two classes ([Deliveries](#deliveries)): the first `finished` line is a wake; a repeat is
  ride-along, so it never wakes the receiver alone and joins its next wake or turn. And when the lane already told
  the receiver (a wake line posted with `from` naming the lane, not a `reply`: SummitFlow's request, never an ack)
  during the turn that just ended, the `finished` line is dropped: the receiver heard it, and the explicit message
  carries the report. The turn is from when Tether first saw the lane working (less 3 s), never before the lane's
  previous idle, including one whose line was still held when the next turn began. Nothing is counted as a report for the drop, so the next idle is a first line again. The check uses
  what this Tether saw in the last 6 hours; a remote lane's launcher is not checked and still gets the line. Log:
  `(told in that turn: <ids>)`.
- **model** *(22, schema 26)*: the lane's model switched, or a refusal paused it ([Model switches](#model-switches)),
  once per switch when its facts are in (`lane_reports.model_key`, so a restart never repeats one). Same receivers as
  `blocked`: `[Model changed] lane "Store lane" (req neri-r1) now on claude-opus-4-8 after a cyber refusal · turn
  stopped · last commit e5a9695 · worktree changed since: no · rewind it (st aico root rewind neri-r1), or relaunch
  from a handoff`. A Codex or Pi lane says `Codex has no supported rewind: relaunch from a handoff`.
- **blocked**: `permission prompt` or `input needed` held `laneBlockedSeconds`, once per episode (a Tether restart
  during the episode does not repeat it). `dialog open` (the
  owner opening a menu in the lane) is not reported.
- **ended**, once: the session ended (End, a failed launch, a host that dropped it), or, for a lane on the receiver's
  computer, its agent left the pane for good (exit 0, or crash recovery holds it) and stayed gone `laneSettleSeconds`.
  An agent that comes back in the same session (`tether recovery resume`) reports again. Tether writes the intent in the same
  transaction as the session's delete, so a crash cannot lose it. A remote lane's `ended` comes from the hub, which
  relays each ended id it knew once. The session an End names in `endedBy` *(21, schema 24)* asked for it and gets no
  `ended` line; when it is the lane's launcher (`parentId`, else the root), the root gets none either, since a lane
  its launcher ended is the launcher's business. An explicit watcher and every other receiver still get one; the
  daemon log names each skip (`skipped <ids>: ended by [its launcher] <id>`). Those spared sessions also lose the
  lane's lines still queued for them (went idle, blocked, an exit's `ended`) through the queue's withdraw; a line
  already delivered, or in a paste going out, stays (log: `withdrew queued <id>:<outcome>,…`). The session named in
  `endedBy` also handled the End for its [waits](#waits): its armed session waits on that lane are cancelled (no line)
  and their queued wait lines withdrawn. Every other waiter, including a root spared the `ended` line because its
  helper ended the lane, keeps its wait, which fires `ended` as usual. Tether keeps the
  name while that End runs (`session_end_requests`) and the delete trigger copies it into the outbox row
  (`lane_outbox.ended_by`); an End that does not happen drops it, and so does a restart. An End without `endedBy`, an
  owner's close, a failed launch and an agent that left report as before. A remote lane's relayed `ended` uses the
  asker the hub took from the `Tether-Ended-By` header *(23)* of an End it forwarded there within 10 minutes; an End
  that did not end it (not `200 {status:"ended"}`, or the host not reached) takes it back. `st aico root end` sends
  the caller's own session (`AICO_WIDGET_ID`) as `endedBy` to a Tether at 21 or later, and for a session on another
  host as that header to a hub at 23 or later (the host's Tether gets the body as is).

Explicit watches, from the watching session (`:id` is the watcher, normally the caller's own session):

| Route | Request | Response |
|---|---|---|
| `GET /v1/sessions/:id/watches` | | `{items: [{lane, mode, createdAt}]}` |
| `POST /v1/sessions/:id/watches` | `{lane, mode}` | `200 {watcher, lane, mode, hears}` |

`mode: "watch"` adds the watcher as a receiver of all that lane's reports (a lane nobody launched included; a root
watching a helper hears all its lines, not only in its launcher's place);
`mode: "unwatch"` drops it, also when lineage would make it one. `hears` says how the watcher hears the lane now:
`lineage`, `watch` or `none`. `409 self_watch` for the watcher itself, `409 watch_cycle` when the watcher already reports
to that lane (a lane watching its own coordinator), which would loop, `409 lane_reports_unavailable` when the daemon runs without lifecycle
(`TETHER_RECONCILE=off`), `404` for an unknown watcher. A watcher's watches end with it. The CLI is
`st aico watch LANE`, `st aico unwatch LANE` and `st aico watch list`.

## Model switches

*(22, schema 26)* Tether follows each session's own record (the Claude Code transcript, the Codex rollout, the Pi
session file; an entry session's through its contained home) and compares the model that answers with the one the
session started on, read from the start of the record. A different model is a switch:
case, a `provider/` prefix, a `[1m]` tag and a date snapshot suffix are the same model. Models a tool may serve
instead of its launch model are data: `~/.config/tether/model-alternates.json`, `{"claude-code": [...], "codex":
[...], "pi": [...]}`, none by default. A `/model` pick of the model a stopped switch moved to makes it the session's
own choice (`changed`, no more Escape). The record is read forward in steps, never skipped, and a switch found while
catching up (after a restart, or a lane already on a fallback when Tether starts) is stopped and told once caught
up. A new agent in the session (another pid or tool) starts the watch again from what it serves; a resumed
conversation is read from its end, and a new conversation is found beside the last one.

| `kind` | When | Interrupt |
|---|---|---|
| `refusal` | Claude Code's `model_refusal_fallback`, Codex's `model_reroute` | Escape |
| `substituted` | an answer from another model with no refusal (Pi's `responseModel`) | Escape |
| `changed` | the owner's `/model` | none |
| `paused` | a refusal with no switch (Claude Code with its fallback off) that left the agent out of its turn for 5 s | none |

The Escape goes at once while the agent works or waits on a permission prompt or input, never into an open dialog,
at most every 5 s (a second Escape opens Claude Code's rewind list), and again each time the other model answers
while the switch stands. Nothing is ended or relaunched. Three seconds later Tether adds the facts: `commit` (the
worktree's last commit), `worktreeChanged` (a commit after the switch, or a changed file written after it) and
`checked: true`. `category` is the refusal's category (`cyber`, …); `rewindTo` is the uuid of the owner's prompt
before the switch (Claude Code only). Only typed values are kept, never the refusal or the request. An answer from
the launch model again clears it. The watch is kept in the `model_watch` setting, so a restart neither repeats nor
loses a switch.

Who is told: a launched lane's launcher gets the `model` line ([Lane reports](#lane-reports)); any other session gets
the owner one Aico notice (`aico-model:<id>:<key>`, "Model changed in …" or "Model refused in …"), from the
Tether that knows Aico's address, resolved when the switch clears or the session ends (or, after a restart, is gone).
A lane whose line has no receiver gets the owner's notice too. Aico shows the switch above
the session.

`POST /v1/sessions/:id/rewind {generation?}` rewinds a Claude Code session to before `rewindTo`, conversation only
(the files stay as they are; a coordinator decides about them): Escape, Escape, Up to that prompt, Enter, "Restore
conversation", Enter, then the prompt's text is cleared from the input. Each screen is read back before the next key
and a mismatch stops it (the list is closed again): every Up must land on the next prompt the transcript has after
the target, newest first. `200 {generation, rewound: true, up, cleared}`, `cleared: false` when the restored prompt's
text is still in the input (clear it before sending); `409 rewind_unsupported` (not Claude Code), `409
no_rewind_target`, `409 already_rewound` (this switch was rewound already), `409 agent_busy` (working), `409
rewind_target_unreadable`, `409 rewind_refused {step, reason}` (a screen did not match: a dialog open, a draft in the
input, a prompt not listed, a list that does not match the transcript), `409 stale_generation`. The model after a rewind is the session's setting, which may still be the fallback; the watch
stops it again if it answers. CLI: `st aico root rewind REQ [--generation G]`, then `st aico root send REQ TEXT
--generation G`.

## Waits

A wait tells an agent when something it waits on is ready, instead of a check-in at a guessed time. Kind `session`:
another session finished a turn, is idle, is blocked on the user, or ended. Lanes an agent launched report on their own
([Lane reports](#lane-reports)); a wait is for anything else. The pull kinds (API 17, below) wait on a service job, a
request, an owner ask, a host; `cmd` (API 18) runs a bounded watcher command of
the waiter's own. The CLI is `st aico wait session ID|REQ
[--until finished|idle|blocked|ended] [--timeout 2h] [--note T] [--key K] [--block]`, `st aico wait job|reply|ask|
host REF [--until …]` with the same options, `st aico wait cmd [--timeout 6h] [--note T] [--key K] [--block] --
ARGV...`, `st aico waits [--recent]`, `st aico wait cancel WAIT`,
`st aico wait get WAIT [--block]`, `st aico wait time WHEN NOTE` (the same as `st aico wake`) and `st aico nudge KIND
REF`. The CLI asks `/v1/version` before it sends a pull kind or a nudge (API 17; `cmd` API 18) and says so when
Tether is older. Waits live in
the `waits` table, apart from wakes, and survive Tether restarts.

- **Level-triggered.** The condition is checked when the wait is armed: a session that already finished after `since`
  fires at once. `since` defaults to the waiter's last `inject` with `from` to that session (or, *(25)*, wake-class delivery
  naming the waiter in `from`: a coordination request or ack, never a ride-along FYI or bare yes), else the launch for the
  session that launched it (on this computer only: follow-ups to another host's session go through the hub
  unrecorded), else the time it is armed. `st aico root send` passes `from` only to a session on this computer whose
  Tether takes it (API 13).
- **finished** is `idle` with a `stateAgentAt` after `since` (an idle Tether saw only at its own start, with no agent
  time, is no turn), held `laneSettleSeconds`, and `waitingOn` null;
  **idle** is `idle` held `laneSettleSeconds`; **blocked** is `permission prompt` or `input needed` held
  `laneBlockedSeconds` (never `dialog open`); **ended** is the session gone, or for a local one its agent left the pane
  for good. A session that ends before any other condition holds fires `gone`. A session that had already ended when
  the wait is armed (a retired id, or a root request's tombstone) fires at once: `until` for `ended`, `gone` for the
  rest; an id Tether never knew is `404`.
- **Once.** Firing moves the wait out of `armed` with a compare-and-set on `seq` and queues the line in the same
  transaction, so it fires once across restarts.
- **Never silent.** A wait past its deadline (default `waitDefaultMinutes`, at most `waitMaxMinutes`) fires `timeout`
  with the last state Tether saw. Only a cancel is quiet, and the CLI confirms it.
- **Delivery.** The line goes on the waiter's delivery queue as an event row (source `wait:<id>`), pasted under the
  [wake](#wakes) gates, events first, under 1800 bytes. It names the session (title cleaned as in lane reports, at most
  60 characters), the outcome, the waiter's own note and the command that shows it; never the session's reply text:
  `[Ready] session "Store lane" (req neri-r1) went idle · re: "merge after" · st aico root status neri-r1`,
  `[Wait over] session "Store lane" (req neri-r1) ended before it went idle · …`,
  `[Wait timed out] session "Store lane" (req neri-r1) not idle yet after 2h: it is working · …`.
  Check-in lists and `maxPerSession` do not count waits. While a waiter has an armed wait its `waitingOn` names it.
- **End.** A waiter's waits end with it, unless End says `keepWakes: true`: then its armed waits are kept, and one that
  becomes ready relaunches the conversation like a kept wake (also when it fires while the End is still running); one
  that times out or whose session is gone is recorded and relaunches nothing. Aico web's End dialog offers keeping
  when the session has check-ins, waits or both.
- **Subagents.** A session wait pastes into the waiter's main agent. When the caller provably is not it (a Codex session
  whose conversation id differs from the caller's `CODEX_THREAD_ID`), the CLI's `thread` makes it `409
  not_main_agent`. Subagents, Workflow agents and agents outside Aico use `--block`.
- **`--block`.** The CLI arms a wait with no waiter (`waiter: null`, `by` its session if any; kept as `armed_by`,
  *schema 27*, so that session's [lane lines](#lane-reports) the wait covers are skipped) and asks `GET
  /v1/waits/:id?wait=55` until it is over, printing the line: exit 0 ready, 4 the session ended first (`gone`), 3
  timed out, 1 cancelled, 2 Tether unreachable for 2 minutes, 130 interrupted. Ctrl-C, SIGTERM or SIGHUP cancels a
  wait the command armed (never a session's own wait, as `st aico wait get ID --block` can hold). The GET is
  idempotent, so `st aico wait get ID --block` picks it up again. Nothing is pasted anywhere. A poll answered at once
  (Tether stopping) is asked again a second later.

| Route | Request | Response |
|---|---|---|
| `POST /v1/waits` | `{waiter, by?, kind, ref, until?, since?, timeoutMinutes?, key?, note?, thread?}` (`until` defaults to the kind's first); kind `cmd` sends `{argv, cwd}` instead of `ref` | `201` the wait with `created: true`, or `200` with `created: false` when the same `waiter` already has an armed wait with that `key` on the same session and `until` (a different one is `409 key_conflict {waitId}`). A key is let go when its wait is over or kept, so it can be used again; a wait with no `waiter` takes no `key` (`400`). `ref` is a session id or a root request id, here or on a connected host. `400 invalid_body {field}`; `404 not_found`; `409 wait_unsupported` (the waiter is not an agent session Tether delivers to: a shell), `409 not_main_agent`, `409 self_wait`, `409 too_many_waits {max}` (`maxWaitsPerSession` armed), `409 waits_unavailable` without lifecycle |
| `POST /v1/waits/check` | `{kind, ref?}` | `200 {kind, ref, armed}`: a nudge. Tether re-reads the armed waits of that kind (on `ref` when given) now, and for a job asks its owner at once. A hint only: no outcome, no text; a lost nudge costs at most the 60 s look. `400 invalid_body` |
| `GET /v1/waits/:waitId` | `?wait=0..55` seconds | the wait, once it is no longer armed or the seconds are up; `404 not_found`, `400 invalid_query` |
| `DELETE /v1/waits/:waitId` | | `200 {cancelled: true, ...wait}`; `409 not_armed {state}` |
| `GET /v1/sessions/:id/waits` | `?recent=1` | `{items}`: armed waits, oldest first; with `recent` also those over in the last day (at most 20) |

A wait is `{id, waiter, kind, ref, host, until, since, deadline, key, note, armedAt, state, outcome, line, firedAt,
observed: {state, detail, title}, kept}`; `state` is `armed`, `fired`, `timed_out` or `cancelled`, `outcome` is
`until`, `timeout` or `gone`. Waits that are over are pruned after `waitKeepDays`. Each fire is logged as
`[tether:waits] wait=… on <kind>=<ref> until -> <waiter>`. Waits that are over are pruned also while nothing is
armed (at least hourly).

### Pull kinds

The truth stays with each thing's owner; Tether reads it read-only when the wait is armed, when it changes (a directory
watch, an event), on a nudge, at every 60 s look and at start. A ref the owner does not know is `404 not_found` at arm.

| Kind | `ref` | `until` | Read from | Fires |
|---|---|---|---|---|
| `job` | a SummitFlow service job id, or a unique prefix of 8+ hex (kept whole) | `done` | `~/.summitflow/services/jobs/<id>.json` (`SUMMITFLOW_SERVICE_STATE_ROOT`, or `TETHER_WAIT_JOBS_DIR`); while the file says `queued`/`running`, `st --no-compact service result <id>` at most once a minute (at once on a nudge) as an idle-weight transient unit, never while host admission is red, so a killed runner reads `interrupted` | `succeeded`, `failed` (with its exit code), `interrupted`; a job file that goes is `gone` |
| `reply` | a coordination request id you sent (`st sessions send`) | `acked` (answered with an intent, also when closed), `closed` | the coordination ledger `~/.summitflow/leases/_coord.json` (`TETHER_WAIT_LEDGER`): its id, state, intent, recipient and withdrawn only, never its text | closed or withdrawn without an answer is `gone` for `acked` |
| `ask` | an owner ask id | `answered` | Tether's asks | `withdrawn` is `gone` |
| `host` | a remote host this hub federates | `connected` | the hub's peer state (`peer.state`) | |
| `cmd` | none sent: Tether makes a 12-hex ref | `succeeded` | the watcher's own unit (below) | exit 0 is `until`; any other end is `gone` (`failed (exit N)`, `failed (signal SIG)`, `failed (timeout)`, `failed (oom-kill)`, `could not start`) |

**`cmd`** (API 18). The waiter sends `argv` (1-64 strings, 16 KB in all, no NUL) and an absolute `cwd`; the CLI sends
the words after `--` untouched and its own directory, with `--timeout` defaulting to 6h. Tether records it under
`<state>/wait-cmd/<ref>.json` and runs it as the transient user unit `aico-wait-<ref>` (`systemd-run --user
--collect --expand-environment=no`, `CPUWeight=idle`, `IOWeight=10`, `MemoryMax=512M`, `RuntimeMaxSec` the time
left to the wait's deadline plus 60 s, so the wait times out first with the watcher still `running`). It is not
started while host admission is red: the 60 s look (or a nudge) starts it once it is not. The unit's
`ExecStopPost` writes systemd's own words for how it ended (`$SERVICE_RESULT $EXIT_CODE $EXIT_STATUS`) to
`<ref>.result`, which Tether reads on the directory watch and at start, so an end while Tether was down is seen. When
the wait is over (fired, timed out, cancelled) Tether stops the unit if it still runs and drops its files; at the 60 s
look it does the same for watchers whose wait is gone (its waiter ended); a wait over while its unit is still starting
stops it once the start returns, and none starts past its deadline. A watcher systemd stopped at its runtime limit
(Tether down past the deadline) reads as the wait timing out. The command runs in the user manager's environment, not
the waiter's: a missing `cwd` ends it `failed (exit 200)`. A `key` returns the armed wait with the same
argv. Lines: `[Ready] command "sleep 20" (aico-wait-<ref>) succeeded · journalctl --user -u aico-wait-<ref>`,
`[Wait over] command "false" (aico-wait-<ref>) failed (exit 1) · …`. `--block` exits 0 on success and 4 on a failure.
`500 cmd_unavailable` when the record cannot be written.

Lines name the thing by typed values only and end with the command that shows it, e.g. `[Ready] service job 66d97c21
(aico) succeeded · st service result <id>`, `[Ready] request fd315b to cc:1c7a9f answered: yes · st sessions inbox`,
`[Wait timed out] ask "Rebuild aico now?" (c0ffee123456) not answered after 2h · tether ask get c0ffee123456`. **Told once.** An ask's answer is told to the session it goes to (source `ask:<id>`); an
`ask` wait by that session fires without a second line.

| Policy field | Default | Meaning |
|---|---|---|
| `waitDefaultMinutes` | 1440 | a wait's timeout when none is given (1-10080) |
| `waitMaxMinutes` | 10080 | the longest timeout (1-43200) |
| `maxWaitsPerSession` | 20 | armed waits one session may hold (1-100) |
| `waitKeepDays` | 7 | waits that are over stay this long (1-30) |

## Deliveries

Other owners queue a line on a session's delivery queue instead of typing into its pane: SummitFlow's coordination
inbox sends `[Message] 1 request from cc:1c7a9f` here, and the agent's turn hook shows the content. The line rides the
same queue as lane reports and waits (wakes, kind `event`): pasted once the agent is idle, nobody has typed for
`quietSeconds` and the input line is empty; a native puller takes it as a notice.
Each line goes out once, whichever way.

- **The line** is one line of at most `noteMaxChars` characters, with no control, format or separator characters, and
  it may not start with `/` or `!` (a pasted slash command or shell escape). Tether does not rewrite it.
- **`source`** is `<owner>:<what>` (`coord:cc:1c7a9f`). A line queued with the source of one still undelivered on the
  same session replaces it (`coalesced: true`, the same id). Tether's own sources (`lane:`, `wait:`, `run:`, `ask:`) are
  refused.
- **Withdraw** (API 18). `DELETE /v1/sessions/:id/deliveries?source=` takes back the source's line that has not gone
  out, e.g. SummitFlow's turn hook when the inbox has nothing waiting any more, so a stale `[Message]` line is never
  pasted. A paste already going out cannot be stopped (`sending: true`); if it fails, the line does not come back.
  Tether withdraws an ask's `[Ask] filed` line to the launcher itself once the ask is answered, done or withdrawn.
- **Classes** *(24)*. A line is a **wake** (the default) or **ride-along** (`ride: true`). A wake is pasted or handed
  to a puller as above. A ride-along line never pastes and never wakes a puller on its own: it waits, and joins the
  next wake's paste or puller text (after the wake lines), or is taken at the session's next natural turn with
  `GET /v1/sessions/:id/due?ride=1`. SummitFlow uses it for a bare acknowledgement that needs nothing, and for
  `st sessions send --fyi` notes. Tether's own went-idle line is a wake the first time and ride-along when it repeats
  (the repeat backoff). A source's newer line replaces the text of one still queued; a wake line makes it a wake,
  and a ride-along line never turns a queued wake ride-along (only a withdraw takes a wake back). A ride-along line
  that never joins anything stays queued until it is taken, withdrawn or the session ends.
- **Taking ride-along lines** *(25)*. A client that shows them at a natural turn peeks first:
  `GET /v1/sessions/:id/due?ride=peek` answers the text and a `token` naming those rows as they are, and takes
  nothing. Once the text is shown, `DELETE /v1/sessions/:id/due?token=` takes exactly those rows (a row replaced by
  a newer line, or made a wake, since stays). A client that times out or dies between the two loses no line; at
  worst it is shown again. `?ride=1` (API 24) still takes them in one step.
  The clients: SummitFlow's `coord-inbox` hook takes them at a Claude Code or Codex prompt (a background task or agent
  reporting back counts as one) and at the main agent's next tool result, never a subagent's (its hook payload carries an
  `agent_id`); Pi's extension takes them at its next tool result. Antigravity has no such hook: its lines paste when it is idle.
- **`from`** *(24)* is optional: up to 8 session ids (8 hex) that sent what the line carries. *(25)* On a wake
  line each counts as a send to this session (as `inject` with `from` does), so a lane's went-idle repeat backoff
  starts over and a wait's default `since` moves to it; on a ride-along line `from` records nothing. For a
  wake line that is not a `reply`, Tether also keeps, in memory for 6 hours, that each of them told this session,
  and a lane that told its launcher during the turn that just ended gets no went-idle line for it
  ([Lane reports](#lane-reports)). **`reply`** *(25)*, optional: the line carries `from`'s answer to this session's
  own request (an ack). An ack may open a turn of work, so it never counts as telling. A reply, ride-along or not,
  shows that what it answers reached each of `from`: a lane among them sends its next `finished` line as a first
  line (a wake). A ride-along reply wakes no one, so it also clears the sender's "told" to this session: a lane
  that asked its launcher something earlier in the turn, then answered the launcher with a ride-along yes, still
  sends that turn's `finished` line, which carries the yes. *(schema 29)* A wake line whose `from` names another
  session reached this one from outside: once it goes out, a lane's next `finished` line is a first line. A line
  with no other sender in `from` does not count. A ride-along reply keeps its senders on the queued row: a sender lane
  that goes idle waiting on something of its own sends no `finished` line, so the row becomes a wake then
  ([Lane reports](#lane-reports)).
- **Receivers** are agent sessions Tether delivers to: Claude Code, Codex, Pi and Antigravity (agy). A
  shell is `409 delivery_unsupported`; the producer keeps its own path for those.
- **State.** `queued` while the row waits or is being pasted, `delivered` with `via` (`paste`, `turn` or `native`) and `deliveredAt`, or
  `dropped` when the row went without a delivery (the session ended, or the line was withdrawn). Records stay 7 days.

**Native pullers.** Claude Code's asyncRewake hook (`hooks/aico-due.sh` in claude-config, which runs
`native/host-steward/aico-due.py`, one poller per session by a lock in `$XDG_RUNTIME_DIR/aico-due/`, ending with the Claude
process that started it) and Pi's extension `packages/tether/integrations/pi/aico-due.ts` (linked as
`~/.pi/agent/extensions/aico-due.ts`) long-poll `GET /v1/sessions/:id/due?wait=55` from inside the session
(`AICO_WIDGET_ID`). Both stop on `404` or `409 delivery_unsupported` and retry other failures after 30 s. While one is
attached, and for 30 s after each poll so it can poll again, the session's due lines go to it instead of the pane:
the same rows, order and 1800-byte budget as a paste, gated only on the agent being idle and the post-delivery
`quietSeconds` (the harness shows a notice, never text in the owner's input). Claude exits its hook with code 2 and
the lines (a "Tether" notice that wakes the session); Pi calls `sendUserMessage(lines, {deliverAs: "followUp"})`. A
newer poll on the same session replaces an older one, which answers `{text: null}`. A poll with `wait=0` answers
`{text: null}` at once and holds nothing. A line is never handed to a poll whose client has gone. Only an interactive
Pi polls (not print or RPC mode), one per session by a pid file in `$XDG_RUNTIME_DIR/aico-due/`. With no puller attached the gated
paste delivers as before, so an older hook, a Tether without the route (API < 16, `404`) or a dead puller loses
nothing.

| Route | Request | Response |
|---|---|---|
| `POST /v1/sessions/:id/deliveries` | `{source, line, ride?, from?, reply?}` | `201` (or `200` when it coalesced) `{id, sessionId, source, state: "queued", queuedAt, deliveredAt: null, via: null, coalesced}`; `400 invalid_body {field, detail}`; `404 not_found`; `409 delivery_unsupported` |
| `DELETE /v1/sessions/:id/deliveries` | `?source=<owner>:<what>` | `200 {sessionId, source, withdrawn, sending}`: how many undelivered lines went, and whether one is being pasted now; `400 invalid_query {field: "source"}` (missing, or one of Tether's own); `404 not_found` |
| `GET /v1/deliveries/:deliveryId` | | `{id, sessionId, source, state, queuedAt, deliveredAt, via}`; `404 not_found` (unknown or older than 7 days) |
| `GET /v1/sessions/:id/due` | `?ride=1` *(24)* | `{text}`: the session's queued ride-along lines (composed like a paste, within the budget), taken once as `native`, or `{text: null}`; `400 invalid_query` (anything but `1` or `peek`, or with `wait`); `409 delivery_unsupported` |
| `GET /v1/sessions/:id/due` | `?ride=peek` *(25)* | `{text, token}`: the same text, nothing taken, or `{text: null, token: null}`; errors as `?ride=1` |
| `DELETE /v1/sessions/:id/due` | `?token=` *(25)* | `{taken}`: the peeked rows still unchanged go, as `native`; `400 invalid_query {field: "token"}`; `409 delivery_unsupported` |
| `GET /v1/sessions/:id/due` | `?wait=0..55` seconds | `{text}`: the next delivery's text once the session's due lines may go to this puller, or `{text: null}` when the seconds are up; `409 delivery_unsupported`, `400 invalid_query` |

## Crash recovery

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /v1/recovery/status` | none | Crash records: waiting, recovering, recovered or held ([crash-recovery.md](crash-recovery.md)) |
| `POST /v1/recovery/:id/resume` | optional `{needs: {memBytes, cpu?, caps?}}` | `202 {id, state:"waiting"}`: try a held session again now. Optional needs seed a lost legacy reservation on the same root and host before queueing recovery. Later retries use durable placement metadata automatically. `409 not_held` or `reservation_unavailable` otherwise. |

An entry configuration can add `probe: ["/absolute/program", "fixed-arg", ...]`. Tether appends the entry's arg and expects JSON `{running: true, pid: POSITIVE_HOST_PID, resumeId: UUID}` for the live native agent, or `{running: false, pid: null, resumeId: null}` while absent. The probe must use process/control-plane facts, never an old transcript as liveness. Exit 75 means temporary unavailability; malformed metadata or other probe failures are terminal. Entries without a probe keep their existing observation adapter. The entry launch itself exits 75 for retryable prerequisites and 78 for invalid configuration/ownership. A fallback shell never counts as a successful restore.

Absent when the daemon runs with `TETHER_RECONCILE=off`.

## Remote hosts

Tether can be a hub over other machines' Tethers (docs/plans/remote-hosts.md). Every client keeps talking to its one local socket and sees remote sessions with no federation logic of its own. Without `~/.config/tether/hosts.json` (or `$TETHER_HOSTS_FILE`) there are no peers and nothing below changes an answer, except `host: null` on descriptors.

**Registry.** `hosts.json` is a list of `{name, ssh, socket, sync?, forwards?, wake?, sleep?, status?, statusOff?, health?, wakeTimeoutSec?, stateDir?}`: `name` is 1-32 of `a-z0-9-` (not `local` or `auto`), `ssh` an ssh Host alias (never an address), `socket` the remote Tether's control socket, `sync` the remote Aico's sync socket (an absolute path; the link forwards it to `<peerDir>/sync.sock`, where aico-web finds it), `forwards` workstation ports the link exposes on the host's loopback, `wake` the argv that powers it on (run by a create, never by the link), `sleep` the argv that powers it off, `status` a read-only argv that says whether it is on (asked only while the link is down, at most every 15 s) with `statusOff` the regular expression that means off in its output (default `\bstopped\b`, as `st vm status` prints), `health` the `http://127.0.0.1:<port>/<path>` URLs a create checks on the host first (the forwarded services), `wakeTimeoutSec` how long a create waits for the host (10-1800, default 240), `stateDir` the remote Tether's state directory when it is not the default. An invalid entry is skipped and logged. Tether rereads the file when it changes.

**Link.** The fleet link carries all peer traffic: one TLS 1.3 connection per peer pair on port 7449, set up in `~/.config/aico/fleet.json` and pinned by enrollment (docs/fleet-link.md). Its local proxy sockets, including the peer's forwarded `control.sock` and `sync.sock`, live in `$XDG_RUNTIME_DIR/aico/fleet/<name>`. While the host is down it retries quietly with backoff; it never powers a host on. The registry's `ssh` alias is for administration and rescue only.

**Peers.** The hub follows each peer's event stream on the forwarded socket. On every link-up it first compares the peer's `GET /v1/health` `host` (`{name, machineId}`) with the one it trusted before (the first one seen is trusted). A different machine marks the host `identity_changed`: nothing is merged or routed for it until the owner accepts it with `POST /v1/hosts/:name/trust`. Then it lists the peer's sessions and runs, reports `connected` and publishes `peer.resync`. Retries use jittered backoff up to 30 s and try at once when the link re-creates its socket.

**Updates.** A peer whose health names an older `apiVersion` gets the full peer's installed release on link-up (`src/hub/update.ts`). The sender must be an approved full peer, and its signed metadata must match all installed release files. The Ed25519 envelope carries the API version, release hash, bundle hash and issue time. It travels on the pinned fleet exec channel; the receiver checks the root-owned public update pins before staging any executable. Unsigned, wrongly signed and older releases are refused; an identical release is a no-op. The install runs in a separate user unit and writes its actual result to a private job file, so the sender can read the result after Tether restarts. The remote control socket comes from that host's registry entry.

**Same API, another build.** `GET /v1/health` also carries `release` (`{hash, issuedAt}`, or null from a checkout): the hash of the installed release files and when their signed update was issued. A hub whose own build differs sends it to a connected peer on the same API once the peer's session list is in and no session, wake, create or update is running there (the update restarts its Tether), and again every 30 s for a peer that waited on its sessions; one attempt per link-up. It never sends over a peer whose `issuedAt` is the same or later (a standby hub that is behind never overwrites a newer deploy), nor to a peer on a newer API. A peer that names no release is sent one; its receiver still refuses an older signed release. The update shows in `GET /v1/hosts` `update.build` (`{from, to}`, short hashes), is logged, and writes the Status row `tether/release-update/<host>` (ok, or failed with the reason). A failure after the install began is not repeated on the same hub release.

One update runs on a host at a time (`flock` on `~/.local/lib/tether/.update.lock`). The installer saves the complete prior release and the stopped service's database and WAL. If the new service does not answer within 90 s, it restores them; a database that cannot be restored leaves the service stopped with the backup's location in the error. A create waits within the host's `wakeTimeoutSec`, then returns `409 host_unavailable` if the update is still running. A failure after installation starts is remembered for that hub release. A failure before installation, including a busy lock, is retried on the next link-up. Powered-off hosts are left off. A peer with no `apiVersion` is left alone.

| Route | Answer |
| --- | --- |
| `GET /v1/hosts` | `{items: [{name, ssh, control, stateDir?, state, since, listedAt, sessions, error, wake, apiVersion, update}]}`. `apiVersion` is the host Tether's from its last health answer (null when unknown); `update` is null, or `{state: "updating"\|"updated"\|"failed", from, to, since, error}` (see Updates above). `wake` is null, or `{state: "starting"\|"failed", reason: "host_starting", step: "powering_on"\|"connecting"\|"checking_services", since, error}` while a create brings the host up (a failed one stays until the host is connected). `state` is `connected`, `connecting` (also while a wake brings it up), `offline`, `powered_off` (the Hosts panel powered it off, or its `status` says so) or `identity_changed`; `error` keeps the raw link error as detail. `control` is the fleet link's local proxy for the host (clients run `tether fleet exec <control> -- …` through it); `listedAt` is when the host's list was last fresh; `error` says why it is not connected. This computer is implied, not listed. |
| `POST /v1/hosts/:name/trust` | `{trusted: true}` and reconnect, after `identity_changed`. `404 unknown_host`; `409 identity_unchanged` when there is nothing to accept. |
| `GET /v1/hosts/:name/logins` | The host's `tether fleet login-status` (`{host, tools: [{tool, state, source, credentials: []}]}`; never a credential value), plus `checkedAt` and `actions: {<tool>: {signIn, signOut: "revoke"\|"command"\|"session"\|null}}`. Run over the pinned fleet exec channel, 20 s limit. `404 unknown_host`; `409 host_unavailable` unless connected; `502 login_status_failed {reason}`. |
| `POST /v1/hosts/:name/power` | `{action: "on"\|"off", force?}`. On: `200 {state: "connected"}` when it already is, else `202 {state: "starting"}` and the create's wake runs in the background (progress on `GET /v1/hosts` and `peer.state`); `409 no_wake_command` without `wake`. Off runs `sleep`: `409 no_sleep_command` without it; `409 host_busy {sessions, reason}` while sessions run there unless `force`; with `force` those sessions are ended first (the host restores running sessions when it boots), and one that will not end is `409 end_failed {reason}` with the host left on; `200 {state: "powering_off", sessions}`; `502 power_failed {reason}`. |
| `POST /v1/hosts/:name/logins/:tool` | `{action: "sign_in"\|"sign_out", origin?, size?}`. Sign in brings the host up like a create. A static tool login is granted in Aico's fleet config and pushed over the link, answering `200 {host, tool, signedIn: true}`. Other tools open a `shell` session there titled `Sign in: <tool>` running the tool's own login (the shell exits when it succeeds, and the hub then ends the session; it stays open with the error when the login fails) and answers `201 {host, session}` (`session.failure: "inject_failed"` when the command could not be typed). Sign out: a static tool login is revoked in Aico and removed on the peer (on reconnect if it is offline) (`{signedOut: true, note?}`), a rotating tool runs its logout on the host, a tool that signs out inside itself opens a session like sign in. `404 unknown_tool`; `502 sign_out_failed {reason}`. |
| `GET /v1/sessions/:id/sign-in-link` | On a `Sign in: <tool>` session whose adapter sets `login.signInLink`: `{tool, url}`, the sign-in URL on the screen joined across its wrapped lines (https, on the adapter's host), `url: null` until the tool prints it. `404 no_sign_in_link` for any other session. Forwarded to the owning host like other session routes; a host on an older Tether answers 404. |

**Sign-in commands.** Claude Code's local command is `claude auth login`; a remote grant delivers the static Claude setup-token. The other static grants are OpenCode Go and the ST agent token. Codex uses its own `codex login --device-auth` / `codex logout`; Codex and Pi OAuth logins are never copied. Pi and agy also support sign-in inside the tool. `host-logins.json` beside `hosts.json` overrides or adds tools: `{<tool>: {signIn, signOut: {kind, line?}, grant?}}`.

**Lists.** `GET /v1/sessions` adds every peer's sessions, asked in parallel with a 1.5 s limit; three failed reads in a row open that peer's circuit for 30 s, and it answers from its last list meanwhile. Filters apply to remote sessions too. A peer's own remote sessions are never merged (no transitive federation). An id that also exists here is logged and the local session wins. `GET /v1/roots` adds each peer's roots for the same query with `host`; a host that is not connected contributes its last list with the `peer` mark.

**Stale, never gone.** While a host is not `connected`, its last-known sessions stay listed with `peer: {state, since, listedAt}`; the hub keeps them across its own restart. When the link drops, the hub publishes `peer.state` and a `session.updated` for each of them with the `peer` mark. It never publishes `session.ended` for them while the host is away. On reconnect it publishes `session.ended {id, host}` for each cached session missing from the host's fresh list (it ended while the link was down, or the host was rolled back), then `peer.resync`; clients re-list. A forwarded stream (chat, events) ends when the host goes away mid-stream.

**Routing.** `/v1/sessions/:id/…`, `/v1/widgets/:id/…`, `/v1/roots/:requestId/…`, `/v1/wakes/:id` and `/v1/asks/:id/…` (read, answer, done, withdraw) for an id a peer owns are forwarded verbatim (method, path, query, headers, body; streams too). A JSON answer gains `host` (and `host` on each item of `items`); a descriptor answer gets the same `host`/`peer` as a listed one. A forwarded attach answer also carries `ssh: {alias, control, stateDir?}` (the field keeps its old name); the client attaches through the fleet link's exec channel on `control`. For a host that is not connected, these routes answer `409 host_unavailable {host, state, reason}`, never 404.

**Asks and shares.** `GET /v1/asks?hosts=all` and `GET /v1/shares?hosts=all` add each peer's, tagged `host`, and `peer: {state, since, listedAt}` while the link is down (the last copy the hub saw, kept across its own restart; never live). Without `hosts=all` they list this Tether's own, so `tether ask list` is unchanged. An answer to a peer's ask goes to the owning Tether, whose own delivery wakes or leaves it for its session; while that host is away it is `409 host_unavailable`. `GET /v1/hosts` items carry `canSleep` (hosts.json has a `sleep` command).

**Create.** `POST /v1/sessions` and `POST /v1/roots` accept `host`: null or absent is this computer; a name sends the create to that host without `host`. An unknown name is `400 unknown_host`. A host that is not connected is first brought up: the hub runs its `wake` (a host that is already on fails it harmlessly), asks the link to retry at once, and waits for the link, the identity check and every `health` URL (fetched on the host through the link with `curl`), within `wakeTimeoutSec`; a host without `wake` gets 10 s for its link. The create answers when the host's own create does, so clients allow `HOST_CREATE_TIMEOUT_MS` (7 min). Concurrent creates for one host share one wake. Meanwhile `GET /v1/hosts` and `peer.state` show `wake`. A host that does not come up, answers as another machine, or whose services do not answer is `409 host_unavailable {host, state, reason}` with the real reason (nothing was created); a link that breaks mid-create is `409 outcome_uncertain`. `GET /v1/tools?host=` and `GET /v1/projects?host=` answer with that host's tools and projects (`host` added). A root's `entry` *(15)* goes only to a host whose health says `apiVersion` 15 or later; to an older one it is `400 entry_unsupported {host, reason}` and nothing is sent. A `codex` root's `entry` *(19)* goes only to a host at 19 or later, and a `pi` root's *(20)* only to one at 20 or later, the same way.

**Placement** *(10)*. `POST /v1/roots` with `host: "auto"` and `needs: {memBytes, cpu?, caps?}` (whole bytes; CPUs 0-1024; up to 8 capability names) lets Tether pick the host (`packages/fleet/src/hub/placement.ts`). `needs` goes with `auto` or *(14)* a named host, `pool` only with `auto`; neither is part of the digest. Hosts are tried in the order of the create's `pool` *(11)* from `~/.config/tether/placement.json` (or `$TETHER_PLACEMENT_FILE`): without `pool` the `default` pool, which is `pools.default` or else `order` (`local` is this computer; hosts that no pool lists follow in hosts.json order); a named pool, `pools.<name>: [host, ...]`, is exactly the hosts it lists, which the default pool then leaves out unless it lists them too (`pools: {"neri-hunt": ["neri-hunters"]}` keeps general work off the hunter VM). `skip` leaves a host out of every pool. A pool the file does not define is `400 unknown_pool {pool, pools}`, nothing reserved; the first whose room fits wins, and the create then goes there exactly as with that host's name (a powered-off host is woken). Room is live free memory and CPUs minus the owner's reserve minus open reservations:
- this computer: host-steward's `admission.json` must be fresh and `green`; free memory is its `mem_available_gib`, free CPUs are the CPU count less the 5-minute load. Amber, red, missing or expired is unknown: nothing is placed here.
- a remote host: its own `MemAvailable`, memory PSI (over Tether's admission thresholds is refused), CPU count and load, read over the link; with `proxmox: {ssh, node, vmid, storage?, reserveGiB?, minFreeStorageGiB?}` also the node's available memory less its reserve and every reservation on that node (the smaller room counts) and the storage's free space (below `minFreeStorageGiB`, default 20, nothing is placed). A powered-off VM counts only when the node has room for its full memory; its room is then its memory less the reserve. A host whose link is down or whose reading fails is unknown.
- a host with `room: "local"` *(14)* (a container on this computer, e.g. a Neri hunt slot): its own `/proc` would show this computer again, so it is judged by this computer's host reading (green and fresh, else unknown, `shares this computer: ...`), less this computer's reserve, the reservations on `local` and on every `room: "local"` host (one shared room, each reservation counted once), and its own `reserveGiB`/`reserveCpu` (default 0) on top. This computer's own verdict counts those hosts' reservations too. Powered off (its link down and hosts.json `status` says off) it fits by that room when hosts.json has `wake`, and the create wakes it; capabilities are read over its link only once it runs, so a powered-off one with `caps` is unknown, unless `capabilitiesOn: "local"`: then they are this computer's (the C2 sandbox, proxy and firewall of a slot made here belong to this computer, not to a proxy inside the container), read with this computer's marker and fingerprint command whether the slot runs or sleeps, never the slot's own marker; a missing or stale one there is `checked on this computer: not live-ready: ...`. `capabilitiesOn` takes only `"local"` and only with `room: "local"`. `room` and `proxmox` do not go together; `room` takes only `"local"` and not on `local` itself (a broken entry is an ordinary host at the remote defaults).
- capabilities: `capabilities.<name>: {marker, fingerprint}` (default `live-ready`: marker `~/.local/state/neri-proxy/live-ready.json`, no fingerprint command) is read on the host; the marker's `fingerprint` must equal what the `fingerprint` argv prints there now. No marker, no command or a different value is not ready; a powered-off host cannot be checked.

Reserves are `hosts.<name>: {reserveGiB, reserveCpu, proxmox?, room?}` (defaults: this computer 6 GiB and 2 CPUs, a host 2 GiB and 1 CPU, a `room: "local"` host 0 and 0, a Proxmox node 2 GiB). A placed root holds its needs on that host from the decision until the Tether that owns it says it is gone, ended or its agent exited; a host that cannot answer keeps them. Restore and crash recovery book a root whose agent exited again before relaunching it here; a root on another host, which its own Tether restores, is booked again at the next decision or dry run once it reports live. A repeat create for an ended or exited root is not judged (it answers as that create does). A host taken out of hosts.json (the hub has no link for it, and
the last hosts.json that was there and parsed does not name it) can take no launch, so its held reservations are
released at the next placement decision or dry run. A host only briefly missing keeps them: an entry held while
invalid, a file that does not parse (at a hub restart too), a file briefly gone, or the hub turned off. Logged `released <requestId> on <host> (host no longer in hosts.json)`. Never on a timer, and kept across a Tether restart (the catalog's settings). Decisions are serialized, so concurrent creates cannot take the same room. A repeat of a placed request goes to the same host. **Named host** *(14)*: a running named host whose link is connecting first gets the existing create readiness wait, including the identity and service checks; a failed wait answers `409 host_unavailable {host, state, reason}`, with nothing reserved or created. Powered-off hosts are still judged and reserved before the create wakes them. `POST /v1/roots` with `host: "<name>"` (a hosts.json name, or `local` for this computer) and `needs` judges that host alone, by the same rules, and holds its reservation in the same serialized step before the create goes there (woken if powered off), so a dry run (`GET /v1/placement`) followed by setup and a named create cannot lose the room in between unnoticed: if it no longer fits the answer is `409 at_capacity` with that one host's reason. A name that is neither `local` nor in hosts.json is `400 unknown_host`; a repeat naming another host than the one the request already holds is `409 request_conflict {host, reason}`. Release is the same as `auto`. A named host without `needs` is not judged or reserved (as before). When nothing fits: `409 at_capacity {hosts: [{host, reason}]}` (at most 16), nothing reserved or created; repeat the create later. `GET /v1/placement?mem=<bytes>&cpu=<n>&cap=<name>&pool=<name>` answers `{needs, pool, host, hosts: [{host, fits, reason, room: {memGiB, cpu} | null, wake?}], reservations}` for the same decision without reserving anything.

**Lineage.** A root created on a host with `launchedBy` naming a session here: the hub makes that session a coordinator as usual and sends the host `lineage: {coordinatorId, coordinatorColor, parentId}` instead of `launchedBy` (`parentId` only to a host whose health says `apiVersion` 9 or later; an older one refuses keys it does not know). `POST /v1/roots` accepts `lineage` (not with `launchedBy`, not part of the digest) and records it on the new session. A remote lane launched by a coordinator here shows `↳ <coordinator>` in its badge. A root here launched by a remote session takes that session's lineage from the hub, with that session as its `parentId`. `launchedBy` naming a session on the same host is passed through.

**Events.** `peer.state {host, state, since, wake}` on every link change and every step of a create's wake. A connected host whose event stream is silent for 20 s (it sends a heartbeat every 15 s) is asked its health; no answer within 5 s drops it to `offline` (a VM that stopped dead never closes the link). Relayed: `session.*`, `root.updated`, `tools.changed`, `projects.changed`, `wakes.changed`, `asks.changed` and `show.requested`, each with `data.host` (an `asks.changed` also puts `host` on its `ask`). Not relayed: a peer's `memory-policy.changed`, and anything a peer itself relayed from its own peers (no transitive federation); an ask this Tether holds is never taken back from a peer.

## Coordination

The one store for agent coordination, kept in `tether.db` (table `coord_docs`, created on first use). A document is a JSON object under a name `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`. A project id names that project's file leases and writer sets; names starting with `_` are the registry: `_coord` (identity registry, handshake messages, peer notes), `_seen` (what each agent's inbox hook has shown), `_queued` (agents with a queued `[Message]` line). Readers and writers: `aico-hook` (the edit hook and the `aico-hook lease|sessions|inbox` verbs), SummitFlow's `st` while it has callers, and this daemon's `reply` waits (a write to `_coord` re-reads them).

- `GET /v1/coordination/docs` lists `{items: [{name, version, updatedAt}]}`.
- `GET /v1/coordination/docs/:name` returns `{name, version, doc, updatedAt}`; an unwritten document reads as `{}` at version 0.
- `PUT /v1/coordination/docs/:name` with `{doc, version}` replaces the document (at most 2 MB) when it is still at `version`, the one the writer read (0 for an unwritten document), and returns `{name, version}` with the new version. Otherwise `409 version_conflict` with `{version}`, the current one.

A writer reads, changes the document and writes it back with the version it read (compare-and-set); on `version_conflict` it reads again and redoes its change, a few times at most. Nothing is held between the read and the write, so a writer that gives up or dies leaves nothing behind, and no update is lost. A reader that gets no answer must not treat the document as empty: aico-hook skips the coordination part of that call (leases are advisory, the edit goes ahead with a warning), and SummitFlow's safety checks (`st commit`'s sweep check, the coordination guard) refuse with "coordination store unavailable".

## Health and version

`GET /v1/health` never touches tmux. It returns:

```json
{"status":"ok","name":"tether","instance":"default","version":"0.1.0","apiVersion":5,"schemaVersion":12,
 "uptimeMs":966,"bootId":"uuid","eventSeq":0,"catalog":{"sessions":0,"tmuxServersActive":0,"rootRequests":0},
 "lifecycle":"ready","host":{"name":"davion-sidarli","machineId":"<16 hex>"}}
```

`host` (8) names the machine: its host name and a hash of `/etc/machine-id`. A hub compares it on every link-up ([Remote hosts](#remote-hosts)).

`lifecycle` is `"reconciling"` until startup reconciliation finishes, then `"ready"`. It is `"disabled"` when the daemon runs with `TETHER_RECONCILE=off` (tests and catalog inspection): startup never observes, adopts or stops a tmux server and the pane-exit watcher is off. Use it only for tests and read-only inspection of a catalog.

`GET /v1/version` returns `{name, version, apiVersion, minApiVersion, node}`.

## Session history

*(27, schema 31)* Tether reads the transcripts the tools keep (Claude Code `~/.claude/projects`, Codex `~/.codex/sessions`, Pi `~/.pi/agent/sessions`) every 15 seconds, one reader per tool (`src/sessions/readers`), and keeps one row per conversation in `transcripts`: tool, model, project, start and end, outcome (`completed`, `aborted`, `error`, or null while a turn runs), token totals (`input` is the uncached part), tool-call count and the files written. A transcript is read from where it stopped; a rewritten one is read again from the start. The first pass looks back `TETHER_HISTORY_DAYS` (3) days; `TETHER_HISTORY_SKIP` (default `neri`) names projects whose transcripts are never read. Subagent transcripts of Claude Code are rows with a `parentId` and appear in the parent's `subagents` totals, not in the list. Events are never stored.

- `GET /v1/history?limit=&tool=&project=&session=` -> `{items: Summary[]}`, newest first. *(30)* `session` keeps the conversations bound to that Tether session, live or ended. A summary's `contextTokens` *(30, schema 34)* is the latest model call's prompt tokens (cached parts included), the conversation's context fill; null until a call is read.
- `GET /v1/history/:id` -> the summary plus `path`, `files: {path, writes}[]` and `subagents`. `:id` is `<tool>:<id>` or the start of the tool's own id (409 `ambiguous_session`, 404 `unknown_session`).
- `GET /v1/history/:id/events?limit=&before=&from=` -> `{items, older, newer, size}`. No cursor: the last `limit` events. `before=<older>` pages back; `from=<offset>` reads forward (`newer`). 410 `transcript_gone` when the tool removed the file.

`aico recent list|show|events` is the CLI (`tether history`).
