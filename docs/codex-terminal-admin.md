# Codex terminal administration qualification

Installed `codex-cli 0.160.1` is qualified for bracketed-paste framing in a
private fixture. Shared-pane automated clear/submission remains unavailable.
`st aico admin ROOT` inspects the capability; pinned `clear`/`submit` requests
fail closed with `native_tui_atomic_admin_unavailable`. They never send terminal
input. No live panes were operated on or rebuilt for this qualification.

## Feedback loop and evidence

Run from the Aico checkout:

```sh
unshare -Urn python3 scripts/qualify-codex-admin.py --raw
unshare -Urn python3 scripts/qualify-codex-admin.py
unshare -Urn python3 scripts/qualify-codex-admin.py --human-draft
unshare -Urn python3 scripts/qualify-codex-admin.py --human-input
```

The fixture has a fresh network namespace with loopback only, fresh Codex state,
private tmux socket, no shared daemon, no credentials, and a synthetic Responses
provider. It imports Aico's actual `bracketedSubmitTextTargetArgs`, sends exactly
one Enter, and compares accepted UTF-8 text by digest. It retains no terminal
text. Automatic title-generation requests are recognized by their structured
output schema and excluded from message-delivery counts.

[Retained command outputs and source hashes](qualifications/codex-admin-0.160.1.json)
record three repetitions of each case:

| Case | Exit | Observed assertion |
| --- | --- | --- |
| Raw text + immediate Enter | 1 | `text + immediate Enter was not accepted` |
| Bracketed text + one Enter | 0 | `accepted:1`, `exact_text:true` |
| Bracketed text with a human draft | 1 | `existing human draft merged into accepted text` |
| Human paste interleaved before Enter | 1 | `human paste between framing and Enter merged into accepted text` |

The green case includes Unicode, shell punctuation, a newline, and a tab. The
source burst guard is 120 ms (`codex-rs/tui/src/bottom_pane/paste_burst.rs`,
`PASTE_ENTER_SUPPRESS_WINDOW`); explicit paste clears its suppression state.
A delay or blind second Enter supplies neither content nor thread authority.

The fixture also executes `/clear` through the actual TUI. `/status` identifies
the fresh active UUID before any new user turn; SQLite still lists only the old
thread until the first new turn. Server/pane/process identity stays the same.
The effective read-only sandbox and `never` approval policy are preserved in
the persisted receipt. Other permission profiles were not qualified.

Aico's `sessionGeneration` hashes process/catalog ownership, excluding native
thread UUID. Its source test confirms that changing only native identity cannot
change that token. This is source/fixture evidence, not a deployed Aico receipt.
The installed app-server `ClientRequest` schema has thread/turn operations but
no TUI composer/input compare-and-apply method.

## Current owner contract

`GET /v1/roots/ROOT/admin` returns the catalog generation, unknown current native
thread, and unavailable capability. `POST` accepts a strict discriminated body:

```json
{"kind":"clear","requestKey":"scope-1","generation":"<sha256>","expectedThreadId":"<uuid>"}
```

`submit` adds `text`, limited to 2000 UTF-8 bytes. Controls that could escape the
paste frame, CR, empty input and malformed pins are rejected. ST reads text
only from bounded stdin. A matching Aico generation still returns HTTP 503,
`applied:false`, and the missing native fences. Stale generations return 409;
ended roots return 410; unsupported tools return 422. No request text is stored
or returned. Rejected operations have no effects, so repeating their key is safe.
Unknown/contradictory receipts or transport failures report `applied:null` with
the same key and never retry. Old runtimes without this route stay unavailable.
Native-unavailable denial receipts must echo the exact kind, request key,
generation and expected thread; missing or mismatched echoes stay unknown.
Other denials must match their HTTP status and cannot carry contradictory pins.
Requests use compact UTF-8 JSON. The 16 KiB admin body bound also accepts the
worst-case `\uXXXX` encoding of schema-valid 2000-byte text plus bounded pins.

The tmux helper requires an absolute private socket and exact `%pane` target;
it frames one paste and one Enter in one command queue. It is a transport
primitive, not an acceptance receipt or permission to operate a shared pane.

## Exact next patch: native TUI compare-and-apply

The missing authority belongs inside the Codex TUI input event loop. An
app-server thread read cannot inspect a local draft or exclude queued human
input. Implement one native operation, then connect the existing Aico route:

| Owner/file | Minimal change |
| --- | --- |
| Codex `codex-rs/tui/src/admin_control.rs` (new), `lib.rs` | Bind one private local endpoint in the running TUI; no extra process. Return a native process epoch, displayed thread ID and monotonic input revision, never draft text. Require an Aico launch-bound endpoint/identity, never an ambient daemon. |
| Codex `app_event.rs`, `app.rs`, `app/input.rs` | Enqueue `AdminCompareAndApply` into the same event loop as key/paste input. Increment input revision for all user input and thread switches. A pending input/partial paste/editor/modal, busy turn, nonempty draft/attachments/queue, or mismatched epoch/thread/revision rejects with zero effects. Do not discard human input. |
| Codex `app/terminal_admin.rs` (new), `app/session_lifecycle.rs` | At one linearization point reserve the request key and input seam. `clear` reuses `load_new_session_config` and `start_fresh_session_with_summary_hint`; return old/new native UUID and the returned effective permission receipt. `submit` uses the existing native user-message submission path, bypassing paste-burst timing, and correlates the accepted turn/item with the key and content digest. Input arriving after reservation is retained for the next draft, never mixed into the submitted text. |
| Codex `tui/schema/terminal-admin.schema.json` (new) | Strict snapshot and compare-and-apply schemas: `requestKey`, `expectedEpoch`, `expectedThreadId`, `expectedInputRevision`, `kind:clear|submit`, bounded `text` only for submit. Receipt: key, state `rejected|pending|applied|uncertain`, old/new thread, input revision, accepted item/turn identity or effective permissions. No text. |
| Aico `electron/main/index.ts`, `root-control.ts`, `store.ts` | Hold the existing widget lifecycle owner lock while verifying current pane/generation and the launch-bound native endpoint; forward native pins once. Add the input-revision pin to the route. Persist a request-key/digest reservation and content-free receipt in the existing SQLite catalog. Same key/content reconciles; changed content conflicts. Never infer native thread from rollouts. |
| Aico `scripts/aico-root-watch.py`, ST manifest | Recognize only the new fully validated native receipt; advertise available only when that exact capability is observed. Keep unknown outcomes unknown. |

Persist the reservation before asynchronous thread start/submission. A crash
after reservation without a sealed receipt is `uncertain` and must never replay
the action. Matching retries query the same identity. This supplies safe
idempotency without claiming exactly-once success after an unknowable crash.

Required red/green tests at `codex-rs/tui/src/app/tests/terminal_admin.rs`: stale
thread/epoch/revision; active turn; draft including attachments/partial paste;
human input queued at the seam; exact Unicode/multiline accepted item; clear
permission carryover; concurrent duplicate keys; conflicting key digest;
disconnect/crash after reservation. Extend Aico's existing private-socket tests
for pane-generation changes during native RPC and mismatched native receipts.

Only after these native tests and an installed isolated fixture pass should the
capability be enabled. Aico's new HTTP metadata/control requires the normal
managed rebuild at the next clean paused seam. This change does not restart or
rearrange the deployed desktop.
