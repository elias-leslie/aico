# Private root control

Tether owns root control. Its `default` instance serves this contract on the
legacy user-private HTTP Unix sockets `$XDG_RUNTIME_DIR/aico/gui-control.sock`
(roots and widgets) and `$XDG_RUNTIME_DIR/aico/control.sock` (session End),
falling back to `/run/user/<uid>/aico/`. `AICO_GUI_CONTROL_SOCKET` and
`AICO_CONTROL_SOCKET` override the paths for the `st aico` client. The
directory is mode 0700 and the sockets mode 0600. Other Tether instances (for
example `tether@dev`) do not serve the legacy sockets. Tether's own API docs
(`docs/api-v1.md`, `docs/compat-contract.md` in the Tether repo) are the
reference for the server side; this page documents the contract as the `st aico`
client relies on it. That client and its tests live in Tether
(`scripts/aico-root-watch.py` there, installed to
`~/.local/lib/tether/scripts/`). This repo's `scripts/aico-root-watch.py` is the
entry SummitFlow runs; it hands over to Tether's installed copy
(`TETHER_ROOT_WATCH` overrides the path). `st aico roots` lists with
`GET /v1/roots?ended=0`, so retained tombstones no longer push the list past the
client's root limit.

Show, position and title reach the Aico window through Tether's GUI channel:
Tether validates the generation and workload, then sends the command to the
connected Aico (`GET /v1/gui/channel`), which applies it and posts the result.
With no Aico connected, those routes return 503 `gui_unavailable`; Tether never
starts the desktop runtime. Status, create and End work without Aico.

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /v1/roots` | none | availability, directed-delivery capability, retained roots |
| `POST /v1/roots` | create body below | existing or reserved root descriptor |
| `GET /v1/roots/<requestId>` | none | current descriptor, including ended tombstones |
| `POST /v1/roots/<requestId>/show` | `{generation}` | shows the existing view or reopens it |
| `POST /v1/roots/<requestId>/position` | `{generation,bounds:{x,y,width,height}}` | positions the view or stores its next placement |
| `POST /v1/roots/<requestId>/title` | `{generation,label}` | renames the exact running root |
| `POST /v1/roots/<requestId>/send` | none supported | 503 `directed_delivery_unavailable` |
| `GET /v1/roots/<requestId>/admin` | none | current catalog generation and unavailable native terminal capability |
| `POST /v1/roots/<requestId>/admin` | strict `kind:clear|submit`, generation, expected native thread and stable request key | generation-checked, fail-closed 503; no terminal input |
| `GET /v1/widgets/<widgetId>` | none | compact exact widget descriptor below |
| `POST /v1/widgets/<widgetId>/title` | `{generation,label}` | renames the exact running widget |
| `POST /v1/widgets/<widgetId>/position` | `{generation,bounds:{x,y,width,height}}` | positions its view or stores its next placement |

Widget routes also address ordinary managed widgets with no `root_requests`
record. The widget ID is exactly eight lowercase hexadecimal characters. A
successful GET or mutation returns exactly `owner: "aico"`, `widgetId`,
`sessionId`, the opaque 64-character lowercase hexadecimal `generation`,
`status` (`running`, `pending`, or `uncertain`), and `available` (true only for
`running`). It contains no title, bounds, project details, prompt, transcript,
or terminal contents. A missing or retired widget returns 404 `not_found`;
retirement while waiting to mutate returns 410 `ended`. A stale generation
returns 409 `stale_generation`; unverifiable workload ownership, a changed
identity during mutation, or an unavailable workload returns 409
`workload_unavailable`. GUI unavailability returns 503 `gui_unavailable`.
The GET rechecks the same generation after observing status; identity changes
during inspection return 409 `stale_generation`.

Show, title and position bodies are strict: exactly `generation` plus the one
field for that kind. Titles are trimmed with ECMAScript whitespace rules,
nonempty, at most 160 UTF-8 bytes, and exclude control characters, lone
surrogates and Unicode line/paragraph separators. Bounds contain exactly integer
`x`, `y`, `width`, and `height`, each with absolute value at most 100000; minimum
size is 360 by 240. Invalid bodies return 400 `invalid_body`.
Tether's `contracts/view-mutation-vectors.json` pins these rules; Tether's suite
and the Python client's pytest suite both run every vector.

Root and widget routes use one canonical mutation handler in Tether, serialized
on the widget identity, so a root request ID and its widget ID cannot interleave
writes. Every kind requires the exact current generation and a `running`
workload. Pending, uncertain or otherwise non-running workloads return 409
`workload_unavailable`; Aico does not show them, store a future placement for
them or rename them. Tether verifies a dispatched launch and an active managed workload, then
rereads the generation before forwarding the command. Aico rechecks the
generation against its own session mirror; existing views use
`BrowserWindow.setBounds` and persist the resulting geometry in Aico's `views`
table, and a running session with no open view saves its next placement there.

Every 4xx/503 rejection above is definitive: nothing was applied. A widget
mutation that applied but whose exact identity cannot be requalified afterwards
returns 409 `outcome_uncertain`.

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
Aico and `--root-url` for A-Term. A-Term's `/v1/roots` now proxies Tether, so its
descriptors carry Tether's 8-hex host identity and an `aico://widget/<id>`
locator with `owner: "a-term"`; the client accepts that shape, and the older
UUID host with an `a-term://pane/<UUID>` locator, but never a mix of the two. Show, title and position read
`GET /v1/roots/<requestId>`, require a qualified `running` descriptor, pin its
generation, then send one request and require the same identity, generation and
`running` status in the receipt. A-Term supports status, show, title and end;
its position returns unavailable, so the facade rejects it locally. End reads
the exact descriptor and pins its generation, but does not require a running
workload: it can contain a pending or uncertain root with a generation. On Aico,
it uses the existing headless `/v1/sessions/<widgetId>/end` containment contract
on `--owner-socket` (default `AICO_CONTROL_SOCKET`) and accepts only the exact
`{status: "ended"}` receipt; on A-Term it uses `/v1/roots/<requestId>/end`.
An already ended tombstone returns `applied: false` with exit 0 and sends
nothing. A root without a generation cannot authorize End. These commands work
for direct and fleet-started roots; for fleet roots,
prefer `st sessions close` so the fleet ledger records the outcome.
`st sessions title` remains a compatibility alias of `st aico root title`.

Roots created by direct `st aico create` are owner roots without SummitFlow fleet
event streams; title, position and widget controls do not create an event stream,
and operators must not use `sessions emit` or `sessions wait` against those roots.

Create accepts exactly `requestId`, `tool` (`codex` or `claude-code`),
`projectId`, absolute normalized `projectRoot`, nonempty `initialPrompt`, `role`,
and optional opaque `leadRootReference`, `facetCapsuleRef`, and `resumeSessionId`.
`resumeSessionId` is either absent/null (the existing fresh launch) or an exact
native session ID validated by the selected TUI's declarative resume capability.
Codex is the only implemented adapter: it requires a canonical lowercase UUID;
Claude and other unsupported resume adapters fail closed. Resume requires a
sanitized nonempty `initialPrompt` of at most 2000 UTF-8 bytes, allowing only
tab/newline controls. It launches the configured Codex command followed by
`resume --no-daemon <UUID> -- <initialPrompt>` in the newly allocated root.
Codex resume uses standalone mode to avoid the incompatible shared-server menu;
fresh launches keep their configured daemon behavior. The installed
`codex resume --help` verifies the UUID and optional prompt positional syntax.
Claude and ordinary fresh launches keep their existing command forms. Identifiers use
1–128 characters from letters, numbers, `.`, `_`, `:`, and `-`, beginning with a
letter or number. Roles and references are generic metadata; Aico interprets no
campaign, focus, scheduling, or orchestration semantics.

The canonical digest covers every create field except the request key. Fresh
launches preserve the original seven-field digest; a non-null resume UUID is
appended as the eighth field. A
transaction reserves the key, widget, and unique logical `ST_SESSION_ID` before
launch. Matching retries reconcile the same widget; changed content returns
409 `request_conflict`. Retirement keeps the request tombstone, so retries
cannot recreate ended work. No prompt or transcript is stored in the catalog.
Before first allocation, an interrupted request needs the same create body to
supply its transient prompt again. After allocation, the existing exact launch
gate and persisted containment state govern recovery; ambiguous outcomes never
authorize a second workload or launcher replay.

Prompt bytes enter the pane's process environment and expand as one quoted
initial argv argument at the verified launch gate. They are never pasted into a
running agent. The unique logical session identity overrides the center's
`ST_SESSION_ID`. A descriptor returns `owner: aico`, opaque `hostIdentity`, the
current exact `generation`, `logicalSessionId`, `surfaceLocator`, metadata,
bounds, and `status` (`running`, `pending`, `uncertain`, or `ended`). Pending or
uncertain create results use HTTP 202. Ended descriptors have null generation.
View mutations require the current generation and reject stale requests.
The existing headless `/v1/sessions/<hostIdentity>/end` owns exact containment
retirement and keeps its existing contract.

The direct ST facade (`st` is the author's workspace tool; `st aico` runs Tether's `scripts/aico-root-watch.py`) creates one root without a fleet ledger or prompt retention:

```sh
st aico create recovery-root-1 'Reconcile current state after the crash before continuing.' --tool codex --project myapp --project-root ~/projects/myapp --resume-session 00000000-0000-4000-8000-000000000001
```

Use the exact saved UUID, a new stable request ID, and the same complete body on
retry. Omit the prompt for the fixed recovery prompt, or use `--stdin` for bounded
UTF-8 input. The facade rejects secrets/framing controls and caps all prompts at
2000 UTF-8 bytes. `--role`, `--lead-root` and `--facet` carry generic metadata.
`--surface a-term` uses A-Term's loopback endpoint, configured by
`A_TERM_ROOT_CONTROL_URL` or `--root-url`; A-Term's authentication remains
enforced, and A-Term forwards the request to Tether. Tether must already be
running; the command does not start it.

Create remains explicit recovery, not automatic reboot recovery. The catalog
stores the request digest rather than a native thread binding or prompt, and
ended requests remain tombstones. The same request cannot revive ended work.
After a second crash, an operator still supplies the exact saved thread UUID and
a new request ID. A running descriptor proves owned workload presence, not native
thread loading, authentication, model readiness, or prompt completion. Failure
receipts are content-free; uncertain responses never authorize an automatic retry
with a different identity.

`st aico root status <requestId>` reports owner workload lifecycle: `running`
means the exact managed process is present. For bounded advisory terminal
activity, use `st aico roots [requestId]` or its `--watch` mode. The watcher
verifies root, owner, tmux server, and pane identity before and after each
visible-screen capture. It emits compact state codes, never pane text. Its
Codex profile retains the existing busy, turn-finished, and warning
classifications. Its `claude-code` profile reports `input_required` only for a
current session-paused safeguard choice, `retrying` for a current API retry
countdown, and `input_required` when both appear together. Ordinary Claude
active, idle, cost, or transcript screens remain `ambiguous`; the watcher cannot
infer a native turn decision from them. Activity observations do not change the
owner's `running` lifecycle status or authorize terminal input.

Directed delivery is deliberately unqualified. An isolated private fixture
inspection of installed `codex-cli 0.160.0` found `codex queue --thread <THREAD>
--message <TEXT>`; `queue send` and `queue list` are unsupported. The exposed
queue contract supplies no workload-generation precondition or correlated
delivery receipt. No authenticated session was launched, and no message was
sent to an existing session. The adapter advertises
`available: false, reason: exact_thread_generation_receipt_unqualified` and
contains no queue invocation or PTY steering path.

The installed Codex 0.160.1 fixture now qualifies bracketed-paste submission and
the TUI `/clear` transition. It also proves draft contamination and lazy native
thread persistence, so neither tmux capture nor rollout lookup supplies an
atomic native thread/idle/draft fence. The `admin` route and `st aico admin`
expose that boundary with bounded, content-free receipts; execution stays
unavailable. See [qualification evidence and exact native patch contract](codex-terminal-admin.md).
