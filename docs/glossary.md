# Aico session context

Aico presents durable terminal sessions as desktop windows. Tether, the per-user session daemon, owns every session; Aico and A-Term are clients that show views of them. A session can be opened from Aico or A-Term without starting another agent process.

## Language

**Project**:
The working directory and project identity selected when starting a session.
_Avoid_: Workspace, when naming the choice in the user interface

**Session**:
One running terminal workload and its durable tmux state, owned by Tether and created from Aico, A-Term, the `tether` CLI or a root request. Closing a view does not end it.
_Avoid_: Widget, attachment, pane, when naming the workload in the user interface

**View**:
A local Aico window or A-Term tab that shows an existing session. Several views may show the same session. Aico stores one view row per session ID (geometry, open state, local name override) in `aico.db`.
_Avoid_: Session, when only the local display is being closed

**Owner**:
Tether. It verifies and ends every session's workload; Aico and A-Term ask it to. A session's `origin` (`aico`, `a-term`, `cli`, `root`) records which client started it, not who may end it.
_Avoid_: Attachment, when describing authority to end a session

**Widget**:
A session as Aico shows it, addressed by Tether's exact eight-character lowercase hexadecimal session ID, which is also the widget ID (`AICO_WIDGET_ID` inside its pane). A widget may have zero or more views.
_Avoid_: Window, when a view may be closed while the session keeps running

**Generation**:
The opaque SHA-256 fence over a widget's exact session identity. Tether computes it; every mutation names the generation it read; a changed generation means a different workload, never a retry target.

**Root**:
A session created through the root contract with a stable caller request ID. The retained request is a tombstone after the session ends, so the same request ID cannot start new work.
_Avoid_: Fleet root, unless SummitFlow registered it

**Fleet root**:
A root that SummitFlow registered (`root-<32 hex>`) in its event ledger before asking an owner to create it. Only fleet roots have `sessions send/wait/emit` streams. A direct `st aico create` root is an owner root without a fleet ledger.

## Owner and fleet state

Tether is the authority for workload state; Aico mirrors it from `GET /v1/sessions` and the `/v1/events` stream, and SummitFlow's fleet state records only what it requested and observed. The session, root and fleet status tables live with the root contract in Tether's [`docs/root-control.md`](https://github.com/elias-leslie/tether/blob/main/docs/root-control.md#owner-and-fleet-state).

Show, position and title for roots and widgets go through Tether's legacy `$XDG_RUNTIME_DIR/aico/gui-control.sock` (`/v1/roots/<requestId>/…` and `/v1/widgets/<widgetId>/…`, one handler for both); `control.sock` beside it only reads and ends sessions. Tether checks the generation, then forwards the view part to Aico over its GUI channel (`GET /v1/gui/channel`); Aico applies it to its window and view row and posts the result.
