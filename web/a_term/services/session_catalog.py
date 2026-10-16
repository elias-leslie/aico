"""The sessions A-Term shows, in A-Term's API shape.

Three kinds of session reach A-Term:

- **Tether sessions** (8-hex ids): every session Tether owns, whichever app
  created it. Aico-created sessions are listed and attached natively.
- **Legacy sessions** (UUID ids): pre-Tether A-Term sessions still running as
  ``summitflow-<uuid>`` on the user's default tmux server. Attach-only until
  they end.
- **Own tmux sessions** (tmux session name ids): the user's own default-server
  sessions running an agent. A-Term shows them but never renames, respawns or
  ends them. The wire keeps ``source: "tmux_external"``.

This module is the seam: callers list, get, attach and end sessions here and
never read an id's shape. Behind it, one adapter per kind
(:mod:`._session_sources`) builds every :class:`Session` key and adds the
capability flags (``can_rename``, ``can_respawn``, ``can_end``) from
:mod:`session_capabilities`, so callers read a flag instead of re-deriving a
rule. A session that no A-Term pane shows is ``is_external`` (the frontend
attaches it as a free-standing view). Pane links live in local view state.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypedDict

from ..constants import AgentState
from ..storage import panes as pane_store
from ..storage.panes import LinkKind
from ..tether import get_client
from ._session_sources import AttachPlan, ListContext, SessionSource, tmux_panes
from ._session_sources.legacy import LegacySource
from ._session_sources.own_tmux import OwnTmuxSource
from ._session_sources.tether import TetherSource, from_tether
from .session_capabilities import SessionKind

__all__ = [
    "AttachPlan",
    "Session",
    "attach_plan",
    "end",
    "from_legacy",
    "from_tether",
    "get_pane_with_sessions",
    "get_session",
    "kind_of",
    "list_panes_with_sessions",
    "list_sessions",
    "list_tether_sessions",
    "live_ids",
    "pane_with_sessions",
    "sessions_by_id",
]


class Session(TypedDict):
    """One session in A-Term's shape. Total: every builder writes every key."""

    id: str
    source: SessionKind
    name: str
    mode: str
    status: str | None
    project_id: str | None
    working_dir: str | None
    user_id: None
    display_order: int
    session_number: int
    is_alive: bool
    created_at: str | None
    last_accessed_at: str | None
    agent_state: AgentState
    tmux_session_name: str | None
    tmux_session_id: str | None
    tmux_pane_id: str | None
    tmux_socket: str | None
    tmux_source: str
    tmux_source_label: str
    is_external: bool  # a View fact: no A-Term pane shows it (link is None)
    is_root: bool
    is_legacy: bool
    origin: str | None
    generation: str | None
    pane_id: str | None
    activity: str
    activity_previous: str
    activity_at: int | None
    activity_detail: str | None
    task: str | None
    badge: dict[str, str] | None
    is_coordinator: bool
    coordinator_id: str | None
    can_rename: bool
    can_respawn: bool
    can_end: bool


# One adapter per kind. Own tmux is last: it owns every id the others don't.
_OWN_TMUX = OwnTmuxSource()
_TETHER = TetherSource()
_LEGACY = LegacySource(infer_mode=_OWN_TMUX.infer_mode)
_SOURCES: tuple[SessionSource, ...] = (_TETHER, _LEGACY, _OWN_TMUX)
_BY_LINK_KIND: dict[LinkKind, SessionSource] = {"tether": _TETHER, "legacy": _LEGACY}


def from_legacy(session_uuid: str, row: dict[str, str], link: dict[str, Any] | None) -> Session:
    """A Legacy pane row -> A-Term session dict (``row`` as the Legacy adapter reads it)."""
    return _LEGACY.build(session_uuid, row, link)


def _context(links: Mapping[str, dict[str, Any]]) -> ListContext:
    return ListContext.build(links, tmux_panes.read_panes)


def _ref_context(session_ref: str) -> ListContext:
    link = pane_store.get_link(session_ref)
    return _context({session_ref: link} if link is not None else {})


def _source_for(session_ref: str) -> SessionSource:
    return next(source for source in _SOURCES if source.owns(session_ref))


def kind_of(session_ref: str) -> SessionKind:
    """The kind of session an id names, from its shape alone (no lookup)."""
    return _source_for(session_ref).kind


def _number_sessions(sessions: list[Session]) -> None:
    counters: dict[tuple[Any, str], int] = {}
    for session in sorted(sessions, key=lambda item: str(item.get("created_at") or "")):
        key = (session.get("project_id"), str(session.get("mode")))
        counters[key] = counters.get(key, 0) + 1
        session["session_number"] = counters[key]


def list_tether_sessions() -> list[dict[str, Any]]:
    """Raw Tether descriptors. Raises :class:`TetherUnavailable` when Tether is down.

    session_broker reads these unshaped; Session rows come from the Tether source.
    """
    return get_client().list_sessions()


def list_sessions(*, include_external: bool = True) -> list[Session]:
    """Every session A-Term can show. Tether being down hides only Tether sessions.

    ``include_external`` adds the user's Own tmux sessions. One call reads the
    default tmux server's panes once, for Legacy and Own tmux alike.
    """
    ctx = _context({link["session_id"]: link for link in pane_store.list_links()})
    sessions = _TETHER.list(ctx) + _LEGACY.list(ctx)
    _number_sessions(sessions)
    if include_external:
        sessions.extend(_OWN_TMUX.list(ctx))
    sessions.sort(key=lambda item: (int(item.get("display_order") or 0), str(item.get("created_at") or "")))
    return sessions


def get_session(session_ref: str) -> Session | None:
    """One session by A-Term id. Tether sessions are live-verified by Tether."""
    return _source_for(session_ref).get(session_ref, _ref_context(session_ref))


def attach_plan(session_ref: str) -> AttachPlan:
    """Resolve ``session_ref`` to an attach plan and touch its pane link.

    Raises ``ValueError`` when the session is gone or cannot be attached. A
    dead session is reported, never re-created.
    """
    ctx = _ref_context(session_ref)
    plan = _source_for(session_ref).attach_plan(session_ref, ctx)
    if session_ref in ctx.links:
        pane_store.touch_link(session_ref)
    return plan


def end(session_ref: str) -> bool:
    """End a session through its adapter; False when it was already gone.

    The caller checks ``refusal("end", ...)`` first and owns the pane link.
    """
    return _source_for(session_ref).end(session_ref)


def live_ids(link_kind: LinkKind) -> set[str]:
    """Ids still running for one kind of pane link.

    ``"tether"`` raises :class:`~a_term.tether.TetherUnavailable` when Tether is
    down; ``"legacy"`` is the default server's ``summitflow-<uuid>`` sessions.
    """
    return _BY_LINK_KIND[link_kind].live_ids()


def sessions_by_id() -> dict[str, Session]:
    return {str(session["id"]): session for session in list_sessions(include_external=False)}


def pane_with_sessions(pane: dict[str, Any], known: dict[str, Session]) -> dict[str, Any]:
    """Attach the live sessions a pane shows (dead links are skipped, not deleted)."""
    sessions = []
    for link in pane_store.links_for_pane(pane["id"]):
        session = known.get(link["session_id"])
        if session is not None:
            sessions.append(session)
    sessions.sort(key=lambda session: str(session.get("mode")))
    return {**pane, "sessions": sessions}


def list_panes_with_sessions(include_detached: bool = False) -> list[dict[str, Any]]:
    known = sessions_by_id()
    return [pane_with_sessions(pane, known) for pane in pane_store.list_panes(include_detached=include_detached)]


def get_pane_with_sessions(pane_id: str) -> dict[str, Any] | None:
    pane = pane_store.get_pane(pane_id)
    if pane is None:
        return None
    return pane_with_sessions(pane, sessions_by_id())
