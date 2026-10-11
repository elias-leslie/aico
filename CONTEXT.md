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

Tether is the authority for workload state; Aico mirrors it from `GET /v1/sessions` and the `/v1/events` stream, and SummitFlow's fleet state records only what it requested and observed.

| Tether session `status` | Root descriptor `status` | Meaning | View mutations |
| --- | --- | --- | --- |
| `running` | `running` | Launch dispatched and an active managed workload verified | Allowed with the current generation |
| `pending` | `pending` | Reserved; never allocated | 409 `workload_unavailable` |
| `uncertain` | `uncertain` | Allocated, but an active workload is not verified | 409 `workload_unavailable` |
| `legacy` | — | A pre-Tether A-Term session on the default tmux server; attach and End only | Not addressable as a root |
| (404) | `ended` | Retired; the root keeps a tombstone with null generation | 410 `ended` (root), 404 (widget) |

| Fleet `status` | `capabilities.launch` | Owner relationship |
| --- | --- | --- |
| `registered` | `unobserved` | Intent recorded before any owner request |
| `registered` | `host-acknowledged` | The owner returned an exact descriptor (any owner status) |
| `registered` | `unavailable` | Owner request failed or was uncertain; retained, never recreated |
| `close-uncertain` | any | End was not confirmed; capacity stays allocated and the root is never relaunched |
| `closed` | any | Owner acknowledged End for the stored generation, or returned the exact ended tombstone |

Show, position and title use one Tether handler for both `/v1/roots/<requestId>/…` and `/v1/widgets/<widgetId>/…` on the legacy `/run/user/<uid>/aico/control.sock`. Tether checks the generation, then forwards the view part to Aico over its GUI channel (`GET /v1/gui/channel`); Aico applies it to its window and view row and posts the result.
