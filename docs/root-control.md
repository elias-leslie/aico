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
| `GET /v1/roots/<requestId>/admin` | none | current catalog generation and unavailable native terminal capability |
| `POST /v1/roots/<requestId>/admin` | strict `kind:clear|submit`, generation, expected native thread and stable request key | generation-checked, fail-closed 503; no terminal input |

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

The direct ST facade creates one root without a fleet ledger or prompt retention:

```sh
st aico create recovery-root-1 'Reconcile current state after the crash before continuing.' --project neri --project-root /srv/workspaces/projects/neri --resume-session 00000000-0000-4000-8000-000000000001
```

Use the exact saved UUID, a new stable request ID, and the same complete body on
retry. Omit the prompt for the fixed recovery prompt, or use `--stdin` for bounded
UTF-8 input. The facade rejects secrets/framing controls and caps all prompts at
2000 UTF-8 bytes. `--role`, `--lead-root` and `--facet` carry generic metadata.
`--surface a-term` uses A-Term's established loopback owner endpoint, configured
by `A_TERM_ROOT_CONTROL_URL` or `--root-url`; owner authentication remains enforced.
A-Term allocates a detached pane; Aico shows its root through the existing launch
path. The owner must already be running; the command does not start it.

Create remains explicit recovery, not automatic reboot recovery. The catalog
stores the request digest rather than a native thread binding or prompt, and
ended requests remain tombstones. The same request cannot revive ended work.
After a second crash, an operator still supplies the exact saved thread UUID and
a new request ID. A running descriptor proves owned workload presence, not native
thread loading, authentication, model readiness, or prompt completion. Failure
receipts are content-free; uncertain responses never authorize an automatic retry
with a different identity.

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

The installed Codex 0.160.1 fixture now qualifies bracketed-paste submission and
the TUI `/clear` transition. It also proves draft contamination and lazy native
thread persistence, so neither tmux capture nor rollout lookup supplies an
atomic native thread/idle/draft fence. The `admin` route and `st aico admin`
expose that boundary with bounded, content-free receipts; execution stays
unavailable. See [qualification evidence and exact native patch contract](codex-terminal-admin.md).
