# Local root workloads

A-Term's existing owner HTTP service exposes `/v1/roots` only to loopback clients,
with its existing configured authentication. No desktop launch or browser focus
is implied. The adapter uses Aico's request/descriptor field names and UTF-8 JSON
array digest. No new scheduler, queue, campaign role, or focus policy is introduced.
Mutating request bodies require `application/json`; browser origins must match
the existing configured CORS origins.

`POST /v1/roots` accepts `requestId`, `tool` (`codex` or `claude-code`),
`projectId`, normalized absolute `projectRoot`, `initialPrompt`, generic `role`,
and optional opaque `leadRootReference` and `facetCapsuleRef`. For Codex only,
optional `resumeThreadId` selects an exact existing thread. It must be a canonical
lowercase UUID (`8-4-4-4-12` hexadecimal digits); UUID version is not restricted.
Null is treated as omitted. Malformed IDs and non-null IDs for `claude-code`
return 400 `invalid_body` before allocation. `initialPrompt` remains required
and transient for resume requests. Identifiers follow
Aico's 1–128 character key format; project IDs are limited to 64 characters by the
existing A-Term schema. Prompt size is limited to 64 KiB and request bodies to
128 KiB. A native enabled configured tool command is required. Qualified command
forms are `codex`, `claude`, and A-Term's established
`claude --dangerously-skip-permissions` configuration, without adding permission
flags. Custom configured arguments, resume/fork subcommands, shell wrappers,
default-tool fallback, and missing project directories return `launch_unavailable`.
Project directories ending with a semicolon also fail launch qualification because
tmux treats that suffix as a command separator.

A transaction reserves one detached existing-style pane, one session, and one
request metadata receipt. The digest covers every create field except request ID.
The canonical array retains its existing seven fields for fresh launches and
appends `resumeThreadId` as the eighth field only when non-null. Existing fresh
receipts and tombstones therefore retain their digest.
Matching retries use the retained identity; changed content returns 409
`request_conflict`. The receipt survives session/pane deletion and maintenance
purge. The one launch attempt is committed before tmux startup. An interruption
after that point is uncertain and never authorizes a second launch. A reservation
interrupted before launch can recover only from the same request body.

Initial startup uses tmux's multiple-argument direct process creation and a fixed
Python launcher. Base64 transports prompt and configuration bytes past tmux's
command separator parser; the launcher decodes them, clears the transient prompt
environment and passes the prompt as exactly one argv argument after `--`. Exact Codex resume executes
`codex resume <UUID> -- <prompt>` using the configured native binary and the same
launcher. No picker, latest-thread selection, transcript lookup, or shell is used.
Both launcher and owner clear the temporary tmux environment. No prompt, transcript, or argv is stored in the root
catalog; the catalog stores the content digest only. The resume UUID is transient
and is not retained in the catalog or returned in descriptors. A reservation
retry must provide the identical resume UUID and prompt; the digest fences it.
Logical `ST_SESSION_ID` is unique per root and overrides the caller's session ID. Initial processes filter
the existing secret environment keys. No root startup, retry, or delivery uses
PTY input, paste, or tmux send-keys. Root sessions are excluded from ordinary dead
session reuse, resurrection, reset, and interactive agent startup.

`GET /v1/roots` lists retained descriptors, and `GET /v1/roots/<requestId>` reads
one descriptor. Each returns `owner: a-term`, `hostIdentity` (session UUID),
`logicalSessionId`, `generation`, `surfaceLocator` (`a-term://pane/<pane UUID>`),
role references, and `status` (`pending`, `running`, `uncertain`, `ended`). Generation
hashes exact tmux server/socket/session/pane identity and Linux process start ticks.
The receipt retains the root process PID/start ticks for release reconciliation.
Socket loss while that process remains alive or unreadable stays uncertain.
Multi-window or multi-pane sessions stay uncertain rather than asserting exact
single-root ownership. Running identifies a live
owned terminal process, not tool readiness, authenticated model delivery, or
prompt completion. Changed generations are uncertain and never silently adopted.
Pending and uncertain creates return 202; ended descriptors have null generation.

`POST /v1/roots/<requestId>/show` accepts `{generation}` and reattaches the existing
pane through the existing view limit and attachment API. It neither focuses a
browser nor starts a workload. Ended mutations return 410; stale generation
returns 409. `position` checks generation then returns 503 `position_unavailable`:
browser grid layout does not support Aico pixel window bounds. `send` always
returns 503 `directed_delivery_unavailable`, with reason
`exact_thread_generation_receipt_unqualified`; no generation-fenced correlated
delivery receipt has been proven. Existing session close APIs retain ownership
of ordinary sessions. `POST /v1/roots/<requestId>/end` accepts `{generation}` and
checks exact server, session, pane and process identity inside tmux's command
queue before killing that session. A failed or ambiguous kill returns
`close_uncertain` and retains the receipt. Only proven session and recorded root
process disappearance retires the
owned session and its empty pane, leaving a terminal root tombstone. Repeated end
returns the same ended descriptor. Stale generations never authorize termination.

Exact resume adds no schema migration; loading its service change requires a
managed backend rebuild. The original root-control deployment requires applying
Alembic revision `e92a6d4b8c10` from verified head `d71b3e920c64`.
This source change does not migrate, rebuild, restart, or deploy the live owner
service. Managed fixtures verify exact
argv and environment handling using an isolated tmux server and a harmless Python
process; authenticated native TUI startup and live browser attachment remain
separately authorized runtime validation.
