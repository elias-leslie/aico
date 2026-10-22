# Root control

A root is a session created through the root contract with a stable caller
`requestId`. This page is the contract: the routes, the create body and its
digest, tombstones, the resume adapters, every validation rule, and how the
`st aico` client relies on them. [api-v1.md](api-v1.md#roots) lists the routes
next to the rest of the v1 API.

The contract came from Aico, moved with the lifecycle at the Phase 3 cutover.
Tether owns it now; Aico's `docs/root-control.md` points here.

## Where it is served

Every instance serves `/v1/roots*` and `/v1/widgets*` on its own socket,
`$XDG_RUNTIME_DIR/tether/<instance>/control.sock`. The `default` instance also
serves the legacy user-private Unix sockets that `st aico` and SummitFlow fleet
use, with Aico's exact wire format (`owner: "aico"`, no `origin` field):

- `$XDG_RUNTIME_DIR/aico/gui-control.sock`: roots and widgets
- `$XDG_RUNTIME_DIR/aico/control.sock`: session End,
  `GET /v1/sessions/<widgetId>` and `POST /v1/sessions/<widgetId>/end`

Both fall back to `/run/user/<uid>/aico/`. `AICO_GUI_CONTROL_SOCKET` and
`AICO_CONTROL_SOCKET` override the paths for the `st aico` client. The
directory is mode 0700 and the sockets mode 0600. Other instances (for example
`tether@dev`) do not serve the legacy sockets.

The `st aico` client and its tests live in this repo
(`scripts/aico-root-watch.py`, installed to `~/.local/lib/tether/scripts/`).
SummitFlow runs Aico's `scripts/aico-root-watch.py`, a shim that hands over to
the installed copy (`TETHER_ROOT_WATCH` overrides the path). `st aico roots`
lists with `GET /v1/roots?ended=0`, so retained tombstones never push the list
past the client's root limit.

Show, position and title reach the Aico window through the GUI channel: Tether
validates the generation and workload, then sends the command to the connected
Aico (`GET /v1/gui/channel`), which applies it and posts the result. With no
Aico connected, those routes return 503 `gui_unavailable`; Tether never starts
the desktop. Status, create and End work without Aico.

## Routes

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /v1/roots` | none | availability, directed-delivery capability, retained roots |
| `POST /v1/roots` | create body below | existing or reserved root descriptor |
| `GET /v1/roots/<requestId>` | none | current descriptor, including ended tombstones |
| `POST /v1/roots/<requestId>/show` | `{generation}` | shows the existing view or reopens it |
| `POST /v1/roots/<requestId>/position` | `{generation,bounds:{x,y,width,height}}` | positions the view or stores its next placement |
| `POST /v1/roots/<requestId>/title` | `{generation,label}` | renames the exact running root |
| `POST /v1/roots/<requestId>/end` | `{generation}` | the shared session End; the tombstone is retained |
| `POST /v1/roots/<requestId>/send` | none supported | 503 `directed_delivery_unavailable` |
| `GET /v1/roots/<requestId>/admin` | none | current catalog generation and unavailable native terminal capability |
| `POST /v1/roots/<requestId>/admin` | strict `kind:clear\|submit`, generation, expected native thread and stable request key | generation-checked, fail-closed 503; no terminal input |
| `GET /v1/widgets/<widgetId>` | none | compact exact widget descriptor below |
| `POST /v1/widgets/<widgetId>/title` | `{generation,label}` | renames the exact running widget |
| `POST /v1/widgets/<widgetId>/position` | `{generation,bounds:{x,y,width,height}}` | positions its view or stores its next placement |
| `POST /v1/widgets/<widgetId>/coordinator` | `{generation,coordinator}` | see [Coordinators](api-v1.md#coordinators) |

Widget routes also address ordinary managed sessions with no root request. The
widget ID is exactly eight lowercase hexadecimal characters. A successful GET or
mutation returns exactly `owner: "aico"`, `widgetId`, `sessionId`, the opaque
64-character lowercase hexadecimal `generation`, `status` (`running`,
`pending`, or `uncertain`), and `available` (true only for `running`). It
contains no title, bounds, project details, prompt, transcript, or terminal
contents. A missing or retired widget returns 404 `not_found`; retirement while
waiting to mutate returns 410 `ended`. A stale generation returns 409
`stale_generation`; unverifiable workload ownership, a changed identity during
mutation, or an unavailable workload returns 409 `workload_unavailable`. GUI
unavailability returns 503 `gui_unavailable`. The GET rechecks the same
generation after observing status; identity changes during inspection return
409 `stale_generation`.

## View mutations

Show, title and position bodies are strict: exactly `generation` plus the one
field for that kind. Titles are trimmed with ECMAScript whitespace rules,
nonempty, at most 160 UTF-8 bytes, and exclude control characters, lone
surrogates and Unicode line/paragraph separators. Bounds contain exactly integer
`x`, `y`, `width`, and `height`, each with absolute value at most 100000;
minimum size is 360 by 240. Invalid bodies return 400 `invalid_body`.
[`contracts/view-mutation-vectors.json`](../contracts/view-mutation-vectors.json)
pins these rules; the TypeScript suite and the Python client's pytest suite both
run every vector.

Root and widget routes use one canonical mutation handler, serialized on the
widget identity, so a root request ID and its widget ID cannot interleave
writes. Every kind requires the exact current generation and a `running`
workload. Pending, uncertain or otherwise non-running workloads return 409
`workload_unavailable`; Aico does not show them, store a future placement for
them or rename them. Tether verifies a dispatched launch and an active managed
workload, then rereads the generation before forwarding the command. Aico
rechecks the generation against its own session mirror; existing views use
`BrowserWindow.setBounds` and persist the resulting geometry in Aico's `views`
table, and a running session with no open view saves its next placement there.

Every 4xx/503 rejection above is definitive: nothing was applied. A widget
mutation that applied but whose exact identity cannot be requalified afterwards
returns 409 `outcome_uncertain`.

## Owner and fleet state

Tether is the authority for workload state. Aico mirrors it from
`GET /v1/sessions` and the `/v1/events` stream; SummitFlow's fleet state records
only what it requested and observed.

| Tether session `status` | Root descriptor `status` | Meaning | View mutations |
| --- | --- | --- | --- |
| `running` | `running` | Launch dispatched and an active managed workload verified | Allowed with the current generation |
| `pending` | `pending` | Reserved; never allocated | 409 `workload_unavailable` |
| `uncertain` | `uncertain` | Allocated, but an active workload is not verified | 409 `workload_unavailable` |
| `legacy` | `uncertain` (`pending` if never allocated) | A lifecycle-v0 session, kept read-only | 409 `workload_unavailable` |
| (404) | `ended` | Retired; the root keeps a tombstone with null generation | 410 `ended` (root), 404 (widget) |

| Fleet `status` | `capabilities.launch` | Owner relationship |
| --- | --- | --- |
| `registered` | `unobserved` | Intent recorded before any owner request |
| `registered` | `host-acknowledged` | The owner returned an exact descriptor (any owner status) |
| `registered` | `unavailable` | Owner request failed or was uncertain; retained, never recreated |
| `close-uncertain` | any | End was not confirmed; capacity stays allocated and the root is never relaunched |
| `closed` | any | Owner acknowledged End for the stored generation, or returned the exact ended tombstone |

## The `st aico` facade

The direct facade uses `AICO_WIDGET_ID` for the current widget, with an explicit
`--widget-id` override. It never selects a focused or recent widget:

```sh
st aico widget status
st aico widget title 'Investigation'
st aico widget position -10 20 900 560
st aico widget status --widget-id aabbcc01 --root-socket /run/user/1000/aico/gui-control.sock
```

All three commands accept `--widget-id` and `--root-socket`. Mutations fetch the
descriptor once, pin its widget, session and generation, then send one mutation
and qualify the success receipt against that pin. Their output adds `operation`
and `applied: true` to the compact descriptor, without echoing title or bounds.
`applied: false` means nothing was applied: either no mutation was sent, or the
owner returned a qualified refusal (`invalid_body`, `not_found`,
`stale_generation`, `workload_unavailable`, `busy`, `ended`, `gui_unavailable`,
`position_unavailable`). `applied: null` means the outcome is unknown: transport
loss or deadline after sending, `outcome_uncertain`, blocked End cleanup,
`close_uncertain`, or any unqualified reply. A failure receipt reports
`status: "uncertain"` because it does not vouch for the workload's current state,
plus a content-free `reason`. No failed request is automatically retried. Exit
codes are 0 for a qualified receipt, 1 for owner/identity failure, and 2 for
invalid input.

Retained roots have the same owner facade by exact request ID:

```sh
st aico root status recovery-root-1
st aico root show recovery-root-1
st aico root title recovery-root-1 'Investigation'
st aico root position recovery-root-1 -10 20 900 560
st aico root end recovery-root-1
```

Each command accepts `--surface aico|a-term` (default Aico), `--root-socket` for
Aico and `--root-url` for A-Term. A-Term's `/v1/roots` proxies Tether, so its
descriptors carry Tether's 8-hex host identity and an `aico://widget/<id>`
locator with `owner: "a-term"`; the client accepts that shape, and the older
UUID host with an `a-term://pane/<UUID>` locator, but never a mix of the two.
Show, title and position read `GET /v1/roots/<requestId>`, require a qualified
`running` descriptor, pin its generation, then send one request and require the
same identity, generation and `running` status in the receipt. A-Term supports
status, show, title and end; its position returns unavailable, so the facade
rejects it locally. End reads the exact descriptor and pins its generation, but
does not require a running workload: it can contain a pending or uncertain root
with a generation. On Aico, it uses the headless `/v1/sessions/<widgetId>/end`
containment contract on `--owner-socket` (default `AICO_CONTROL_SOCKET`) and
accepts only the exact `{status: "ended"}` receipt; on A-Term it uses
`/v1/roots/<requestId>/end`. An already ended tombstone returns
`applied: false` with exit 0 and sends nothing. A root without a generation
cannot authorize End. These commands work for direct and fleet-started roots;
for fleet roots, prefer `st sessions close` so the fleet ledger records the
outcome. `st sessions title` remains a compatibility alias of
`st aico root title`.

Roots created by direct `st aico create` are owner roots without SummitFlow
fleet event streams; title, position and widget controls do not create an event
stream, and operators must not use `sessions emit` or `sessions wait` against
those roots.

## Create

### Quick coordination path

Launch a requested Codex model without changing shared defaults or using a
model picker:

```sh
st aico create review-1 'Read the brief at /path/BRIEF.md.' --tool codex \
  --project PROJECT --project-root /path/project \
  --model gpt-6.1-sol --reasoning-effort high --daybreak off
st aico root title review-1 'Review'
st aico roots review-1
```

For an ordinary followup, use `st sessions send AGENT 'instruction'
--source-key REVISION`; the recipient acknowledges it and the sender confirms
the exchange. An exact native Codex UUID can instead use `--delivery
native-thread`; `st -P PROJECT sessions verify UUID --source-key REVISION`
reads that delivery's retained receipt. Live Codex sends use its coordination
inbox, whose hook or idle watcher surfaces the request. Offline sends use the
native queue. Reusing the same source key reconciles the original send.
Queued means retained; seen means surfaced; acknowledged means the agent
answered. None proves the requested work finished. Live inbox verification
reports no native turn-execution proof, and an expired inbox receipt is unknown.
Native verification of live sends requires receipts created after this repair.

Recycle only a session the coordinator opened, after its report and checkpoint
are verified: `st aico root end OLD_REQUEST`, verify `status: ended`, then
create a fresh root with a new request ID, the followup brief, and the requested
model/effort. This retains native history and avoids `/clear` resetting model
defaults. Do not use `--resume-session` when the purpose is fresh context.
`st aico admin clear|submit` remains unavailable: its native compare-and-apply
interface is absent. Routine followups and recycling need no desktop focus or
operator tmux input. The existing idle watcher may use exact-pane tmux internally;
it is not an atomic native submission receipt. If the supported route leaves a
request queued, observe it and keep the same key rather than pasting a second
copy into the pane.

`model` and `reasoningEffort` are per-launch create fields for Codex and Pi; boolean `daybreak` is Codex-only. Model IDs
are passed literally, without a hardcoded model catalog. Native Codex validates
availability and whether the selected model supports the effort. The options
apply to fresh and exact-resume launches, are included in the request digest,
and do not alter persistent defaults. Use `--daybreak off` when the connected
server cannot confirm Daybreak support for the requested model; omit it to
inherit the user's setting. A nonempty selection appends
`{model: string|null, reasoningEffort: string|null, daybreak?: boolean}` after the existing digest
fields, preserving digests for callers that omit both fields.

Pi requires an explicit `--model PROVIDER/MODEL`, including on resume. For example,
`--tool pi --model openai/gpt-6.1-sol --reasoning-effort high` passes native
`--provider openai --model gpt-6.1-sol --thinking high`. This avoids inheriting
a different provider from Pi's saved default. Pi efforts are `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max`; `none` and Daybreak are refused. Authentication
failure remains a native error, with no provider or paid-key fallback added here.
Exact UUID resume uses Pi's `--session` in the original working directory, without
a picker. Use the original `projectRoot`: a UUID from another directory enters
Pi's native fork confirmation and creates a new UUID if confirmed. Automatic Pi conversation
discovery for reboot/crash recovery is unavailable; no new runtime state is installed.
Pi terminal observation remains `unsupported_profile`, and atomic follow-up submission
is unavailable. Use exact root status/end and a new create request for a fresh instruction.

Create accepts exactly `requestId`, `tool` (a root-capable slug, today
`claude-code`, `codex` or `pi`),
`projectId`, absolute normalized `projectRoot`, nonempty `initialPrompt`, `role`,
and optional opaque `leadRootReference`, `facetCapsuleRef`, and
`resumeSessionId`, `model`, `reasoningEffort`, and `daybreak`. On `/v1` it also accepts `origin`, `aTermSessionId` and
`launchedBy` ([api-v1.md](api-v1.md#roots)); none of them is part of the digest.

A tool is root-capable exactly when it has a resume adapter; `GET /v1/tools`
reports it as `rootCapable`. Any other tool string, aliases included, returns
400 `unsupported_tool` with `supported` listing the root-capable slugs. The
`st aico create` client keeps no tool list of its own: it sends `--tool` as
given and reports that refusal as `reason: "unsupported_tool"` with
`supportedTools`.
Observation is different: `st aico roots` reads each root's terminal through a
per-tool status profile (codex and claude-code today) and reports a root of any
other tool as `unsupported_profile`, so a new root tool needs no change to
`create` but does need a profile before `roots` can observe it.

`resumeSessionId` is either absent/null (a fresh launch) or an exact native
session ID validated by the selected tool's resume adapter. The adapters are
code (`src/lifecycle/tui/registry.ts` `RESUME_ADAPTERS`), never editable through
the API. Codex and Claude Code each require a canonical lowercase UUID. Resume
requires a sanitized nonempty `initialPrompt` of at most 2000 UTF-8 bytes,
allowing only tab/newline controls. It launches the configured command followed
by the adapter's fixed arguments, the session ID and `-- <initialPrompt>`:
`resume --no-daemon <UUID>` for Codex (standalone mode avoids the incompatible
shared-server menu; fresh launches keep their configured daemon behavior) and
`--resume <UUID>` for Claude Code. Fresh launches keep their existing command
forms.

Identifiers use 1–128 characters from letters, numbers, `.`, `_`, `:`, and `-`,
beginning with a letter or number. Roles and references are generic metadata;
Tether interprets no campaign, focus, scheduling, or orchestration semantics.

The canonical digest covers every create field except the request key and the
`/v1`-only fields. Fresh launches keep the original seven-field digest; a
non-null resume UUID is appended as the eighth field. A transaction reserves the
key, widget, and unique logical `ST_SESSION_ID` before launch. Matching retries
reconcile the same widget; changed content returns 409 `request_conflict`.
A new request whose resume UUID belongs to a session that crash recovery will
resume, or holds, returns 409 `recovery_pending` with that `widgetId`
([crash-recovery.md](crash-recovery.md)).
Retirement keeps the request tombstone, so retries cannot recreate ended work.
No prompt or transcript is stored in the catalog. Before first allocation, an
interrupted request needs the same create body to supply its transient prompt
again. After allocation, the exact launch gate and persisted containment state
govern recovery; ambiguous outcomes never authorize a second workload or
launcher replay.

Prompt bytes enter the pane's process environment and expand as one quoted
initial argv argument at the verified launch gate. They are never pasted into a
running agent. The unique logical session identity overrides the center's
`ST_SESSION_ID`. A descriptor returns `owner`, opaque `hostIdentity`, the
current exact `generation`, `logicalSessionId`, `surfaceLocator`, metadata,
bounds, and `status` (`running`, `pending`, `uncertain`, or `ended`). Pending or
uncertain create results use HTTP 202. Ended descriptors have null generation.
View mutations require the current generation and reject stale requests. The
headless `/v1/sessions/<hostIdentity>/end` owns exact containment retirement.

The direct facade (`st` is the author's workspace tool; `st aico` runs this
repo's `scripts/aico-root-watch.py`) creates one root without a fleet ledger or
prompt retention:

```sh
st aico create recovery-root-1 'Reconcile current state after the crash before continuing.' --tool codex --project myapp --project-root ~/projects/myapp --resume-session 00000000-0000-4000-8000-000000000001
```

Use the exact saved UUID, a new stable request ID, and the same complete body on
retry. Omit the prompt for the fixed recovery prompt, or use `--stdin` for
bounded UTF-8 input. The facade rejects secrets/framing controls and caps all
prompts at 2000 UTF-8 bytes. `--role`, `--lead-root` and `--facet` carry generic
metadata. `--surface a-term` uses A-Term's loopback endpoint: `--root-url`, else
`http://127.0.0.1:<backend_port>` from the `project.identity.json` in A-Term's
checkout (its root in Tether's project list); when that can't be read the
command stops and says so. Through `st`, `--root-url` is the only override: st
does not pass `A_TERM_ROOT_CONTROL_URL` to the extension. Running
`scripts/aico-root-watch.py` directly, that variable still takes the place of
the identity lookup. A-Term's authentication remains
enforced, and A-Term forwards the request to Tether. Tether must already be
running; the command does not start it.

Create is explicit recovery. Automatic reboot recovery is a separate path
([reboot-continuity.md](reboot-continuity.md)). The catalog stores the request
digest rather than a native thread binding or prompt, and ended requests remain
tombstones. The same request cannot revive ended work. After a second crash, an
operator still supplies the exact saved thread UUID and a new request ID. A
running descriptor proves owned workload presence, not native thread loading,
authentication, model readiness, or prompt completion. Failure receipts are
content-free; uncertain responses never authorize an automatic retry with a
different identity.

## Activity observation

`st aico root status <requestId>` reports owner workload lifecycle: `running`
means the exact managed process is present. For bounded advisory terminal
activity, use `st aico roots [requestId]` or its `--watch` mode. The watcher
verifies root, owner, tmux server, and pane identity before and after each
visible-screen capture. It emits compact state codes, never pane text. Its
Codex profile keeps the busy, turn-finished, and warning classifications. Its
`claude-code` profile reports `input_required` only for a current
session-paused safeguard choice, `retrying` for a current API retry countdown,
and `input_required` when both appear together. Ordinary Claude active, idle,
cost, or transcript screens remain `ambiguous`; the watcher cannot infer a
native turn decision from them. Activity observations do not change the owner's
`running` lifecycle status or authorize terminal input.

## Directed delivery and terminal admin

Directed delivery is deliberately unqualified. An isolated private fixture
inspection of installed `codex-cli 0.160.0` found `codex queue --thread <THREAD>
--message <TEXT>`; `queue send` and `queue list` are unsupported. The exposed
queue contract supplies no workload-generation precondition or correlated
delivery receipt. No authenticated session was launched, and no message was
sent to an existing session. The adapter advertises
`available: false, reason: exact_thread_generation_receipt_unqualified` and
contains no queue invocation or PTY steering path.

The installed Codex 0.160.1 fixture qualifies bracketed-paste submission and the
TUI `/clear` transition. It also proves draft contamination and lazy native
thread persistence, so neither tmux capture nor rollout lookup supplies an
atomic native thread/idle/draft fence. The `admin` route and `st aico admin`
expose that boundary with bounded, content-free receipts; execution stays
unavailable, and a root whose tool is not Codex gets 422 `unsupported_tool`. The
qualification evidence and exact native patch contract are in Aico's
[codex-terminal-admin.md](https://github.com/elias-leslie/aico/blob/040df2b286dd6e43cc7c7b608ac88ac9b972951b/docs/codex-terminal-admin.md)
(a fixed revision, so the link survives Aico moving its history docs).

## Full session inventory

`st aico sessions` reads Tether's current catalog, including ordinary/unlinked Pi
and Codex widgets as well as retained coordinator-created roots. It reports exact
widget IDs, ownership/coordinator IDs, tool, project/title, workload status and
agent state. `roots` covers retained roots only. The inventory includes retained
sessions with no visible window; Tether omits ended sessions. `--owner-socket`
selects an exact Tether control socket. No terminal capture, input or focus change
is involved.
