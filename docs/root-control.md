# Private root control

Electron main owns a separate user-private HTTP Unix socket:
`$XDG_RUNTIME_DIR/aico/gui-control.sock`, falling back to
`/run/user/<uid>/aico/gui-control.sock`. `AICO_GUI_CONTROL_SOCKET` may override
the absolute path. The directory is mode 0700 and the socket is mode 0600,
using the established owner-socket safety checks. Connection absence means
`gui_unavailable`; the headless owner also returns that explicit error for root
routes. Root control never starts the desktop runtime.

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /v1/roots` | none | availability, directed-delivery capability, retained roots |
| `POST /v1/roots` | create body below | existing or reserved root descriptor |
| `GET /v1/roots/<requestId>` | none | current descriptor, including ended tombstones |
| `POST /v1/roots/<requestId>/show` | `{generation}` | shows the existing view or reopens it |
| `POST /v1/roots/<requestId>/position` | `{generation,bounds:{x,y,width,height}}` | positions the view or stores its next placement |
| `POST /v1/roots/<requestId>/send` | none supported | 503 `directed_delivery_unavailable` |

Create accepts exactly `requestId`, `tool` (`codex` or `claude-code`),
`projectId`, absolute normalized `projectRoot`, nonempty `initialPrompt`, `role`,
and optional opaque `leadRootReference` and `facetCapsuleRef`. Identifiers use
1–128 characters from letters, numbers, `.`, `_`, `:`, and `-`, beginning with a
letter or number. Roles and references are generic metadata; Aico interprets no
campaign, focus, scheduling, or orchestration semantics.

The canonical digest covers every create field except the request key. A
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

Directed delivery is deliberately unqualified. An isolated private fixture
inspection of installed `codex-cli 0.160.0` found `codex queue --thread <THREAD>
--message <TEXT>`; `queue send` and `queue list` are unsupported. The exposed
queue contract supplies no workload-generation precondition or correlated
delivery receipt. No authenticated session was launched, and no message was
sent to an existing session. The adapter advertises
`available: false, reason: exact_thread_generation_receipt_unqualified` and
contains no queue invocation or PTY steering path.

This source change does not deploy or restart the production desktop. Unit and
private-socket integration fixtures exercise the contract; live Electron
placement and authenticated native TUI behavior require a separately authorized
runtime validation.
