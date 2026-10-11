# Tether context

Tether is the per-user authority for durable terminal sessions. Aico and A-Term are its clients: they show sessions, but they don't own them.

## Language

### Sessions

**Session**:
One running terminal workload and its durable tmux state, owned by Tether whichever app created it. Closing a view does not end it.
_Avoid_: Widget, pane, attachment, when naming the workload

**Session ID**:
The eight-character lowercase hexadecimal identity of a session (`AICO_WIDGET_ID` inside its pane). It is never reused.
_Avoid_: Widget ID, outside Aico compatibility surfaces

**Ownership ID**:
The stable ownership label carried in the pane as `AICO_SESSION_ID`.
_Avoid_: Session ID

**Generation**:
The opaque fence over a session's exact identity. Every mutation names the generation it read. A different generation means a different workload, never a retry target.
_Avoid_: Version, revision

**End**:
The explicit, contained retirement of a session's workload. An ended session is never silently resurrected.
_Avoid_: Kill, close, delete

**Respawn**:
Replacing the workload inside an existing session, which gives it a new generation.
_Avoid_: Restart, recreate

**Legacy session**:
A session created before the managed lifecycle (lifecycle v0). It is kept read-only.

### Roots

**Root**:
A session created through the root contract with a stable caller request ID.
_Avoid_: Fleet root, unless SummitFlow registered it

**Tombstone**:
The retained request record of an ended root. It stops the same request ID from starting new work.

**Fleet root**:
A root that SummitFlow registered in its own ledger before asking Tether to create it.

### Clients and views

**View**:
An app's local display of an existing session: an Aico window or an A-Term pane or tab. Apps own their views; Tether does not.
_Avoid_: Session, when only the display is meant

**GUI client**:
The one connected Aico desktop that applies show, position and title to its views on Tether's behalf.

**Active client**:
The attached terminal client whose grid size the session's window currently follows.

### Runtime

**Instance**:
One independent Tether with its own catalog, socket and tmux servers (`default`, `dev`, …). Instances never touch each other's sessions.

**tmux server generation**:
One immutable private tmux server process, identified by its generation ID and running in its own systemd unit.
_Avoid_: Socket, when the server identity is meant

**Agent tool**:
A registry entry that defines what a session launches: the agent CLI argv, its process name, and its context hook. It is shared by both apps.
_Avoid_: TUI, mode, agent

**Project**:
The working directory and identity a session starts in. It comes from SummitFlow when SummitFlow is installed.
_Avoid_: Workspace

**Owner** (retired):
The former cross-app authority to end a session. Tether is now the only authority, so this term only appears in compatibility fields such as `owner: "aico"`.
