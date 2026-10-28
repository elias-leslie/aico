# Root control

A root is a session created through the root contract with a stable caller
`requestId`. This page is the contract: the routes, the create body and its
digest, tombstones, the resume adapters, every validation rule, and how the
`st aico` client relies on them. [api-v1.md](../tether/docs/api-v1.md#roots) lists the routes
next to the rest of the v1 API.

The contract came from Aico's desktop app and moved into Tether with the
lifecycle. Tether owns it.

## Where it is served

Every instance serves `/v1/roots*` and `/v1/widgets*` on its own socket,
`$XDG_RUNTIME_DIR/tether/<instance>/control.sock` (directory 0700, socket 0600).
`st aico` and SummitFlow fleet use that socket: `TETHER_SOCKET` names another,
else `TETHER_INSTANCE` picks the instance (default `default`). A root's `owner`
is its stored origin (`aico` or `a-term`) and the descriptor carries `origin`.
The old `$XDG_RUNTIME_DIR/aico/control.sock` and `gui-control.sock` are gone
(2026-10-24).

The `st aico` client and its tests live in this repo
(`tether/scripts/aico-root-watch.py`, also installed to
`~/.local/lib/tether/scripts/`). SummitFlow runs it from the aico checkout. `st aico roots`
lists with `GET /v1/roots?ended=0`, so retained tombstones never push the list
past the client's root limit.

Show, position and title reach the Aico window through the GUI channel: Tether
validates the generation and workload, then sends the command to the connected
Aico (`GET /v1/gui/channel`), which applies it and posts the result. With no
Aico connected, those routes return 503 `gui_unavailable`; Tether never starts
the desktop. Status, create and End work without Aico.

A new root opens an Aico window by itself only when the desktop or `st aico
create` started it. A root the web app started appears in the desktop's catalog
and tray without a window (open it from there).

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
| `POST /v1/widgets/<widgetId>/coordinator` | `{generation,coordinator}` | see [Coordinators](../tether/docs/api-v1.md#coordinators) |

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
[`contracts/view-mutation-vectors.json`](../tether/contracts/view-mutation-vectors.json)
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
st aico widget status --widget-id aabbcc01 --root-socket /run/user/1000/tether/default/control.sock
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
st aico root send recovery-root-1 'Also run the focused tests.' --generation SHA256
```

Each command accepts `--root-socket` to pin an exact Tether socket. There is no `--surface` or `--root-url`: the web app has no root route,
so `st aico` only talks to Aico and Tether. A stored root whose owner is `a-term`
(requested through the web app before it dropped the route) is still read: the client
accepts Tether's 8-hex host identity at `aico://widget/<id>` with `owner: "a-term"`, and
the older UUID host with an `a-term://pane/<UUID>` locator, but never a mix of the two.
Show, title and position read `GET /v1/roots/<requestId>`, require a qualified
`running` descriptor, pin its generation, then send one request and require the
same identity, generation and `running` status in the receipt. End reads the exact descriptor and pins its generation, but
does not require a running workload: it can contain a pending or uncertain root
with a generation. It uses Tether's `/v1/sessions/<widgetId>/end` containment
contract (`--owner-socket` pins an exact socket) and accepts only a
`status: "ended"` receipt; Tether may add `contextFinalization`. An already ended tombstone returns
`applied: false` with exit 0 and sends nothing. A root without a generation
cannot authorize End. These commands work for direct and fleet-started roots;
for fleet roots, prefer `st sessions close` so the fleet ledger records the
outcome. `st sessions title` remains a compatibility alias of
`st aico root title`.

Send queues one follow-up into the exact running root a coordinator created,
including Blank Slate roots of any tool. `--generation` is required and is the
generation the coordinator last read from `root status`: a root that restarted,
was replaced or ended no longer matches, and send refuses with `applied: false`
before any input. Text is `TEXT` or `--stdin`, under the create prompt rules
(at most 2000 UTF-8 bytes, tab and newline only, no credentials). Send reads
`GET /v1/roots/<requestId>`, requires `running` and the pinned generation, reads
the host session `GET /v1/sessions/<widgetId>` and requires the same widget and
generation, then makes one `POST /v1/sessions/<widgetId>/inject` (`mode: paste`,
`submit: true`). Tether fences the generation again under the session's
lifecycle lock and sends one bracketed paste and one Enter; a busy Claude Code,
Codex or Pi TUI queues it as steering, an idle one starts a turn. The success
receipt adds `operation: "send"`, `applied: true`, `delivered: true` and the
byte count, never the text. Delivered means the pane received it, not that the
agent consumed it: watch `st aico roots REQUEST_ID`. A refusal (`not_found`,
`stale_generation`, `workload_unavailable`, `invalid_text`) is `applied: false`
and safe to correct and resend. `applied: null` (transport loss or an
unqualified reply after the inject was sent) may have delivered: check the
root's transcript or screen before sending again, because a paste has no
idempotency key. The model, reasoning effort and context are unchanged. Paste
framing does not exclude a human typing in the same pane at that moment.

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

For a followup to a root the coordinator created with `st aico create`, use
`st aico root send REQUEST_ID 'instruction' --generation SHA256` (above). For
other agents, use `st sessions send AGENT 'instruction'
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

`model` and `reasoningEffort` are per-launch create fields for Codex and Pi. Boolean
`daybreak` supports Codex and Pi's explicit `openai/gpt-6-sol` selection. Model IDs
are passed literally, without a hardcoded model catalog. Native Codex validates
availability and whether the selected model supports the effort. The options
apply to fresh and exact-resume launches, are included in the request digest,
and do not alter persistent defaults. Codex Daybreak is per model and per
account: Codex's own catalog (`~/.codex/models_cache.json`, a model's
`available_access_programs.cyber` containing `daybreak_blue`) decides, and
Codex itself fails the first turn with "Daybreak is unavailable for model ..."
otherwise. `st aico create --tool codex --daybreak on` checks that catalog first
and refuses a model it lists without Daybreak, naming the models that have it;
pick one of those or pass `--daybreak off`. Codex takes a bare model name
(`gpt-6.1-sol`) and sends it as given, so a name the ChatGPT login's catalog
lacks (`openai/gpt-6.1-sol`) fails the first turn with 400 `model_not_found`;
`st aico create --tool codex --model` refuses such a name before creating the
root, naming the bare slug or the listed models. An API key login, a custom
`model_provider` or an unreadable catalog skips that check. Omit `--daybreak` to inherit the
user's setting. A nonempty selection appends
`{model: string|null, reasoningEffort: string|null, daybreak?: boolean, agentHubContext?: boolean}` after the existing digest
fields, preserving digests for callers that omit both fields.

Pi requires an explicit `--model PROVIDER/MODEL`, including on resume. For example,
`--tool pi --work-role implementation --model openai/gpt-6.1-sol --reasoning-effort high` passes native
`--provider openai --model gpt-6.1-sol --thinking high`. This avoids inheriting
a different provider from Pi's saved default. The registry's `pi --approve`
carries Pi's project trust; Tether adds `--approve` only to a Pi command that
lacks it. A fresh Pi root also gets `--session-id <uuid>` so crash recovery and
reboot continuity know its conversation. Pi efforts are `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max`; `none` is refused. Authentication
failure remains a native error, with no provider or paid-key fallback added here.

Pi's source-linked Agent Hub extension handles explicit Daybreak selection through
the native OpenAI provider's model metadata, including compaction and nested
provider calls. `--daybreak on` requests `access_programs.cyber=daybreak_blue`;
`--daybreak off` requests `standard`. Both require `openai/gpt-6-sol`; omission
leaves native provider behavior unchanged. The extension preserves native
authentication and the dynamic provider catalog. Project/model/program access
still requires a separate harmless authenticated qualification.

`--agent-hub-context on|off` is Pi-only and controls **optional** Agent Hub context
for this session. Off omits advisory references, reference/project indexes, tool
guidance and continuity. Required global/project policy, mandates, guardrails,
Pi's native/project instructions, and session ingestion remain active. Omission
and `on` keep the existing default. Explicit values are included in create
idempotency and carried through fresh/resumed launch environment; no persistent
settings are changed.

For two independent sessions, use distinct request IDs and change only the last
flag (replace the project ID/path with the intended registered project):

```bash
st aico create pi-context-on 'Reply OK.' --project PROJECT --project-root /absolute/project \
  --tool pi --work-role implementation --model openai/gpt-6-sol --reasoning-effort xhigh --daybreak on --agent-hub-context on
st aico create pi-context-off 'Reply OK.' --project PROJECT --project-root /absolute/project \
  --tool pi --work-role implementation --model openai/gpt-6-sol --reasoning-effort xhigh --daybreak on --agent-hub-context off
```

Integrate the Tether and Agent Hub checkpoints together, rebuild/restart Tether
through its managed service, and verify the source-linked Pi adapter installation
before starting new sessions. Existing Pi processes must reload extensions (or
start fresh) to use updated source; a source checkpoint alone does not qualify
provider access or prove delivery to a live model.

### Blank Slate

A Blank Slate session starts with the harness's own prompt and the user's
words, and nothing first-party. Pick **Blank Slate** at the top of a tool's
workspace list under New session (control surface or tray), or create a root
with `--blank-slate` instead of `--project`/`--project-root`:

```bash
st aico create review-1 'Read /abs/brief.md and follow it.' --tool claude-code --work-role review --blank-slate
```

Claude Code, Codex and Pi support it; Antigravity does not (its context comes
from a user-level plugin no launch flag skips), and Aico offers no Blank Slate
row for it. `--blank-slate` refuses `--project-root`, `--resume-session` and
`--agent-hub-context`; Pi also refuses `--daybreak` (that comes from the Agent
Hub extension). `--project` defaults to `blank-slate`. The HTTP form is
`POST /v1/sessions {"tool", "blankSlate": true, ...}` or a `/v1/roots` create
whose `projectRoot` is a Blank Slate workspace.

The session's workspace is a new empty directory,
`~/.local/share/aico/blank-slate/<id>` (the request ID for a root). Tether keys
the mode on that path, so restarts, tool replacement, crash recovery and reboot
restore keep it. It launches through `scripts/aico-blank-slate`, which execs the
native harness, never the Agent Hub launcher. For Claude it also records that
one workspace as trusted in `~/.claude.json` (what accepting Claude's folder
trust prompt records; Claude has no launch option that skips it), so a new
empty workspace does not stop at that prompt. The file is replaced only when
no one wrote it since it was read, with its mode kept.

| Tool | Off | Kept |
| --- | --- | --- |
| Claude Code | Agent Hub launcher, CLAUDE.md files (user, project, added dirs), auto-memory, user settings (plugins, output style, every hook but PreToolUse), MCP servers, slash commands/skills, Claude in Chrome | PreToolUse guards, model, effort/thinking and the status line from `~/.claude/settings.json` |
| Codex | Agent Hub launcher and `developer_instructions`, AGENTS.md, skills list, plugins (and their MCP servers), apps, memories, each `config.toml` MCP server, extra sandbox writable roots, every `hooks.json` handler but PreToolUse | PreToolUse guards and their trust |
| Pi | Agent Hub and st-coord extensions, skills, AGENTS.md/context files, prompt templates, MCP | none (Pi's guards are extension code) |

What the model still receives, measured on captured requests (2026-10-26):

- the provider/harness system prompt and tool definitions (Claude ~4K
  characters; Pi ~2.9K; Codex base instructions, permissions, collaboration
  and multi-agent blocks, and `environment_context` naming the empty cwd);
- Claude Code's own reminders (the signed-in account email and git attribution)
  and, when signed in to claude.ai, its account features' tool instructions
  (Artifact, Workflow and similar), which no launch option turns off;
- the opening prompt, plus a guard's refusal text if a PreToolUse guard blocks a
  tool call (they are silent otherwise).

Not added: Agent Hub policy or mandates, memory, project or repo files,
skills, MCP tools, Aico/SummitFlow hook output. Agent Hub does not ingest or
bind these sessions. The pane environment still carries `AICO_*`/`ST_*`
variables (not in the prompt; a tool call could read them). Aico's context
column reports `not_applicable` with "Blank Slate: ...".

### Chosen instructions

Any new session can start with a versioned instruction set: an Agent Hub
prompt revision. A Blank Slate session gets only these; any other session gets
them on top of its usual context.

```bash
st aico create review-1 'Read /abs/brief.md and follow it.' --tool codex --work-role review \
  --blank-slate --instructions code-reviewer@20110df2
```

`PROMPT@REVISION` takes a revision ID or a unique prefix of one from the 100
most recent (`st prompt revisions PROMPT`); bare `PROMPT` takes the revision
holding its current content and refuses when there is none. `st aico create`
reads the revision through `st prompt` and sends Tether an immutable snapshot
(`instructions` on `/v1/roots` or `/v1/sessions`). The root digest covers the
revision ID. Tether keeps it at `~/.local/share/aico/instructions/<widget>.md`
(plus `.json` naming the revision), so restarts, resume, crash recovery and
reboot restore launch with the same text even if the prompt changes later.
Each launch reads that file: Claude Code and Pi get `--append-system-prompt`,
Codex `-c developer_instructions='''...'''`; the Agent Hub launchers merge it
with their own context. Antigravity takes none. Content must be 1 byte to
64 KiB, without control characters other than tab and newline, or `'''`.

On the desktop, a tool that takes instructions shows **Instructions** at the
top of its New session workspace picker: choose a prompt (type to filter the
enabled ones), then a revision from its 100 most recent, newest first (the one
marked current holds the prompt's content now; one Tether can't take shows as
"can't be used"). The choice applies to the next session started from that
picker; Aico reads the revision through `st prompt` when the session is
created, and a failed read starts nothing and says why in the window.

After launch the revision shows as `· prompt@revision` at the end of the
session title (desktop, web, `st`), as `instructions` on the session
descriptor, and in the context detail.

Exact UUID resume uses Pi's `--session` in the original working directory, without
a picker. Use the original `projectRoot`: a UUID from another directory enters
Pi's native fork confirmation and creates a new UUID if confirmed. Automatic Pi conversation
discovery for reboot/crash recovery is unavailable; no new runtime state is installed.
Pi terminal observation remains `unsupported_profile`, and atomic follow-up submission
is unavailable. `st aico root send` queues a generation-fenced follow-up in the
running Pi root; end it and create a new request when the instruction needs fresh context.

New roots require an explicit `workRole` from Agent Hub’s canonical work-role registry:
`coordinator`, `implementation`, `research`, `review`, `recon`, `hunting`,
`operations`, `selection`, `verification`, `reporting`, or `other`. Use `--work-role implementation`.
`--work-role-name Builder` optionally
sets a human display name. The opaque `--role` field keeps its existing meaning.
Work roles never come from titles, prompts, coordinator membership, or a parent.
Tether transports safe explicit IDs; Agent Hub owns registry membership validation.

The declaration and optional name are immutable root creation metadata. They
append `{workRole, workRoleDisplayName}` to the digest after all existing fields.
The pane receives `ST_WORK_ROLE`, `ST_WORK_ROLE_SOURCE` (the immutable root
logical identity prefixed by `tether:root:`), and `ST_WORK_ROLE_DISPLAY_NAME`.
No launch prompt text is added. Agent Hub context delivery reads the same
variables and selects context for the root with the audience tag
`work-role:<id>`; Blank Slate roots run no delivery. Same-request retries and tombstones retain the
original declaration; changing either declaration field conflicts. Legacy
requests can still retry with their original body/digest and remain Unknown;
a new request without a work role returns `400 work_role_required`.

Native producers register the declaration against the actual native UUID.
Resuming a UUID retains its first native-session declaration in Agent Hub;
choose that same role on resume. A different role requires a new native session
or a fitting existing one. Tether's logical root ID is provenance, never the
native UUID. Existing owner-created sessions and imported roots stay Unknown.

Create accepts exactly `requestId`, `tool` (a root-capable slug, today
`claude-code`, `codex`, `pi` or `agent-hub`),
`projectId`, absolute normalized `projectRoot`, nonempty `initialPrompt`, `role`, `workRole`, optional `workRoleDisplayName`,
and optional opaque `leadRootReference`, `facetCapsuleRef`, and
`resumeSessionId`, `model`, `reasoningEffort`, `daybreak` and `agentSlug` (`agent-hub` only). On `/v1` it also accepts `origin`, `aTermSessionId` and
`launchedBy` ([api-v1.md](../tether/docs/api-v1.md#roots)); none of them is part of the digest.

`agent-hub` is the one root kind with no terminal: a chat session on an Agent Hub agent
(`st aico create REQ PROMPT --tool agent-hub --agent SLUG --project P --project-root PATH
--work-role R [--model M]`). `agentSlug` is required for it and refused for every other tool;
it is appended to the digest (`{agentSlug}`) only when present, so existing digests do not
change. Tether creates the Agent Hub session under its own id, with the root's ownership id
as `external_id`, and posts `initialPrompt` as the first turn; `st aico root send` posts a
follow-up (queued while a turn runs), `st aico roots` reports `busy` while a turn runs and
`turn_finished` when idle, and `st aico root end` cancels the turn and closes the Agent Hub
session. It shows as a child of the coordinator that launched it like any other root.
Aico opens it as a native chat window (the shared `@agent-hub/chat-ui`: streaming text,
thinking and tool blocks, Stop, a follow-up typed during a turn shown as queued) instead of a
terminal. Tether makes every Agent Hub call; the window's main process asks Tether over its
private socket for that window's own session, so the owner token and the Agent Hub address
never reach the page. `show` and `position` reach the desktop for these roots; `title` and
`coordinator` stay catalog-only. Resume, reasoning effort, Daybreak, Agent Hub context and Blank Slate do not apply.
[api-v1.md](../tether/docs/api-v1.md#agent-hub-sessions) has the session behavior.

A tmux tool is root-capable exactly when it has a resume adapter; `GET /v1/tools`
reports it as `rootCapable`. Any other tool string, aliases included, returns
400 `unsupported_tool` with `supported` listing the root-capable slugs. The
`st aico create` client keeps no tool list of its own: it sends `--tool` as
given and reports that refusal as `reason: "unsupported_tool"` with
`supportedTools`.
Observation is different: `st aico roots` reads each root's terminal through a
per-tool status profile (codex and claude-code today) and reports a root of any
other tool as `unsupported_profile`, so a new root tool needs no change to
`create` but does need a profile before `roots` can observe it.
An `agent-hub` root needs no profile: `roots` reads its turn state from Tether's session
descriptor (`terminal: busy` for a running turn, `turn_finished` when idle, `ambiguous` when
Agent Hub cannot be reached) and reports `backend: "agent-hub"`.

`resumeSessionId` is either absent/null (a fresh launch) or an exact native
session ID validated by the selected tool's resume adapter. The adapters are
code (`src/lifecycle/tui/registry.ts` `RESUME_ADAPTERS`), never editable through
the API. Codex and Claude Code each require a canonical lowercase UUID. Resume
requires a sanitized nonempty `initialPrompt` of at most 2000 UTF-8 bytes,
allowing only tab/newline controls. A fresh `initialPrompt` may be up to 14 KiB:
it travels as one tmux `-e` value, and tmux refuses a client command over
16 KiB. A longer prompt returns 400 `prompt_too_long` with the `limit` it
exceeded, before anything is reserved. It launches the configured command followed
by the adapter's fixed arguments, the session ID and `-- <initialPrompt>`:
`resume --no-daemon <UUID>` for Codex (standalone mode avoids the incompatible
shared-server menu; fresh launches keep their configured daemon behavior) and
`--resume <UUID>` for Claude Code. Fresh launches keep their existing command
forms.

Identifiers use 1–128 characters from letters, numbers, `.`, `_`, `:`, and `-`,
beginning with a letter or number. Roles and references are generic metadata;
Tether interprets no campaign, focus, scheduling, or orchestration semantics.

The canonical digest covers every create field except the request key and the
`/v1`-only fields. Legacy fresh launches keep the original seven-field digest; a
non-null resume UUID is appended as the eighth field. A transaction reserves the
key, widget, and unique logical `ST_SESSION_ID` before launch. Matching retries
reconcile the same widget; changed content returns 409 `request_conflict`.
A new request whose resume UUID belongs to a session that crash recovery will
resume, or holds, returns 409 `recovery_pending` with that `widgetId`
([crash-recovery.md](../tether/docs/crash-recovery.md)).
Retirement keeps the request tombstone, so retries cannot recreate ended work.
No prompt or transcript is stored in the catalog. Before first allocation, an
interrupted request needs the same create body to supply its transient prompt
again. After allocation, the exact launch gate and persisted containment state
govern recovery; ambiguous outcomes never authorize a second workload or
launcher replay.

Prompt bytes enter the pane's process environment and expand as one quoted
initial argv argument at the verified launch gate. They are never pasted into a
running agent. Copies outside the catalog remain: the agent's argv and its pane
shell's environment for the workload's life, and, when the launch starts a new
tmux server, that server's transient systemd unit command line until the server
exits. Session creation drops the prompt from the tmux session environment in
the same tmux command, so new windows do not inherit it. The unique logical session identity overrides the center's
`ST_SESSION_ID`. A descriptor returns `owner`, opaque `hostIdentity`, the
current exact `generation`, `logicalSessionId`, `surfaceLocator`, metadata,
bounds, and `status` (`running`, `pending`, `uncertain`, or `ended`). Pending or
uncertain create results use HTTP 202. Ended descriptors have null generation.
View mutations require the current generation and reject stale requests. The
headless `/v1/sessions/<hostIdentity>/end` owns exact containment retirement.

The direct facade (`st` is the author's workspace tool; `st aico` runs this
repo's `tether/scripts/aico-root-watch.py`) creates one root without a fleet ledger or
catalog prompt retention:

```sh
st aico create recovery-root-1 'Reconcile current state after the crash before continuing.' --tool codex --work-role implementation --project myapp --project-root ~/projects/myapp --resume-session 00000000-0000-4000-8000-000000000001
```

Use the exact saved UUID, a new stable request ID, and the same complete body on
retry. Omit the prompt for the fixed recovery prompt, or use `--stdin` for
bounded UTF-8 input. The facade caps all prompts at 2000 UTF-8 bytes and
rejects secrets and framing controls, naming which check failed. Put a longer
brief in a file and pass a short prompt naming its path; inlining it with
`"$(cat FILE)"` hits the same cap. `--role`, `--lead-root` and `--facet` carry generic
metadata. `--root-socket` selects Aico's GUI socket. Tether must already be
running; the command does not start it.

Create is explicit recovery. Automatic reboot recovery is a separate path
([reboot-continuity.md](../tether/docs/reboot-continuity.md)). The catalog stores the request
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

## The web app has no root route

The Node web server (`aico-web`, port 3002) serves the browser UI at `/`, the API
at `/api` and the terminal WebSocket at `/ws`. It deliberately does not forward
`/v1/roots`; the Python backend that did, on `127.0.0.1:8002`, is gone. Roots go
through Aico's GUI socket (`st aico create|root`) or Tether's own `/v1/roots`
(SummitFlow's fleet calls Tether directly). `st aico` can no longer target the
web app, and SummitFlow refuses to start roots on an `a-term` surface.

### Owner and origin

Tether stores the origin a root was requested through. On its `/v1` socket a
root's `owner` is that origin and the descriptor carries `origin`, so roots the
web app requested earlier still report `owner: "a-term"`, and
`GET /v1/roots?origin=a-term` still lists them. (Tether's legacy Aico sockets
keep `owner: "aico"` for `st aico`.) `hostIdentity` (the 8-hex Tether session
ID), `generation`, `logicalSessionId` and `surfaceLocator` are unchanged, so
the identity SummitFlow retains stays stable. A root requested through Aico
reports `owner: "aico"`. The origin name stays `a-term`; it is an identifier.
