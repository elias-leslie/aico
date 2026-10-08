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
unshare -Urn python3 scripts/qualify-codex-admin.py --leading-escape
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

The additional `--leading-escape` regression succeeds only when it reproduces
literal `[200~` framing in the synthetic composer without a provider call. It
reports `qualified:false`, `literal_frame:true` and exits 0 on that assertion.
The retained qualification receipt above predates this additional case.

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
All denial/error receipts used to conclude `applied:false` must echo the exact
kind, request key, generation and expected thread; missing or mismatched echoes
stay unknown.
Denials must also match their HTTP status. Current owner errors without these
echoes are projected as `applied:null` rather than inferred nonapplication.
Requests use compact UTF-8 JSON. The 16 KiB admin body bound also accepts the
worst-case `\uXXXX` encoding of schema-valid 2000-byte text plus bounded pins.

The tmux helper requires an absolute private socket and exact `%pane` target;
it frames one paste and one Enter in one command queue. It is a transport
primitive, not an acceptance receipt or permission to operate a shared pane.

For an owner-authorized, initialized, known-idle pane with an empty draft, send
the qualified paste and Enter without a leading `Escape`. Adjacent ESC bytes
can be consumed as one Esc event, leaving `[200~` as literal draft text.
`C-u` deletes to the current line's start; at an empty line's start it removes
only the preceding newline. It does not clear the whole draft. Recover a known
malformed draft with exact backspaces only when its full contents and cursor
position are known, or have the owner empty the composer before submitting.

## Disabled native source checkpoint

The local pinned-source checkout `codex-terminal-admin-0.160.1` now retains a
private submit/control prototype behind the off-by-default
`terminal-admin-private` Cargo feature. Normal builds do not bind that endpoint.
The reader patch is retained with its exact upstream revision and MIT notice,
not vendored or selected by the normal Cargo manifest. The unwired Aico
`native-admin.ts` adapter validates correlated submit receipts; it rejects clear
locally without contacting the native endpoint. No Aico launch, owner HTTP
route or ST facade has been enabled. Every public mutation still fails closed.
The [private source qualification receipt](qualifications/codex-native-private-0.160.1.json)
records the isolated submit fixture, native/managed checks and baseline failures;
it explicitly lists the unqualified invariants.

The remaining invariant is concrete: a Core submission may be buffered or
already dequeued before acquiring `active_turn`; mailbox/automatic work may
wait below the idle gates. Holding then dropping those gates merely lets old
work run after a clear handoff. TUI unsubscribe does not retire the old session,
and existing shutdown queues behind pending Ops. A private RAII experiment
therefore did not qualify atomic clear and was removed, rather than changing
the scheduler/session lifecycle. Input comparison must also be atomic with
Core's submission admission before public submit is enabled.

Ordinary `/clear` has also been observed to reload model defaults. A future
native clear must preserve effective model, reasoning effort and permissions
explicitly and test persisted-default drift; preserving permissions alone is
insufficient. No live-safe-clear claim follows from the private TUI fixture.

## Remaining native compare-and-apply work

Keep the next authorized change narrow, but qualify the complete contract:

- Atomically compare displayed native thread, truly idle Core admission, empty
  draft/attachments and reader/input revision. Cover buffered Ops, already
  dequeued work, queued mail and automatic-start races without recording or
  queueing rejected input. Preserve ordinary submit/turn behavior.
- Clear must prevent any old-thread work from executing after handoff, release
  reservations on every success/error/cancel path, and preserve the runtime
  effective model/effort/permissions even when persisted defaults differ.
- Aico must hold its existing lifecycle owner lock, verify dispatched workload
  and exact pane/generation plus launch-bound native endpoint, forward once,
  and accept only a completely correlated content-free native receipt. ST
  remains a compact facade; raw tmux framing is never acceptance.

Reserve the key/digest durably before effects. A crash with no sealed receipt
is uncertain and must never replay. Matching retries reconcile the same key;
changed content conflicts. Required tests include stale pins, drafts, partial
paste, Core queues/races, busy/active-goal rejection, exact literal Unicode input,
duplicate/conflicting keys, crash ambiguity, clear settings drift and Aico
generation changes during RPC. Private reader/TUI positives alone cannot
enable public routing. Any rollout still requires a separate owner-authorized
safe seam; this checkpoint does not rebuild or restart the deployed desktop.
