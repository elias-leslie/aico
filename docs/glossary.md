# Aico session context

Aico presents durable terminal sessions in two front ends: desktop windows, and the web app in a browser or on a phone (`aico.summitflow.dev`). Tether, the per-user session daemon, owns every session; both front ends are clients that show views of them. A session can be opened from either without starting another agent process.

## Language

**Project**:
The working directory and project identity selected when starting a session. The project list comes from Tether.
_Avoid_: Workspace, when naming the choice in the user interface

**Session**:
One running terminal workload and its durable tmux state, owned by Tether and created from the desktop, the web app, the `tether` CLI or a root request. Closing a view does not end it.
_Avoid_: Widget, attachment, pane, when naming the workload in the user interface

**View**:
A desktop window or a web app tab that shows an existing session. Several views may show the same session. The desktop stores one view row per session ID (geometry, open state, local name override) in `aico.db`; the web app keeps its tabs in `~/.local/state/aico/web.db`.
_Avoid_: Session, when only the local display is being closed

**Owner**:
Tether. It verifies and ends every session's workload; the front ends ask it to. A session's `origin` (`aico` for the desktop, `a-term` for the web app, `cli`, `root`) records which client started it, not who may end it.
_Avoid_: Attachment, when describing authority to end a session

**Own tmux session**:
A session the user started on their own default tmux server that is running an agent. The web app discovers and shows it, but Tether does not own it, so the web app never renames, respawns or ends it; closing it only closes the view.
_Avoid_: External session (the wire value `source: "tmux_external"` is kept for compatibility)

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
