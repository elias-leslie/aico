"""Session lifecycle, delegated to Tether.

A-Term never creates or kills tmux sessions itself. It asks Tether to create
a session (``origin=a-term``), to End it, or to respawn its workload, and it
records which pane shows the session. Ending is always explicit: a dead
session is never silently re-created, and closing a view never ends a session.

Legacy ``summitflow-*`` sessions on the default tmux server are attach-only:
they can be ended (A-Term created them) but never respawned or reset.
"""

from __future__ import annotations

import uuid
from typing import Any

from ..config import TMUX_DEFAULT_COLS, TMUX_DEFAULT_ROWS
from ..logging_config import get_logger
from ..storage import panes as pane_store
from ..storage import project_settings as settings_store
from ..tether import TetherError, get_client
from ..utils import tmux
from . import agent_tools, session_catalog

logger = get_logger(__name__)

ORIGIN = "a-term"
SHELL_MODE = "shell"


class LifecycleError(Exception):
    """A lifecycle request A-Term refuses before reaching Tether."""

    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------
def create_session(
    *,
    pane_id: str,
    mode: str,
    project_id: str | None = None,
    working_dir: str | None = None,
    name: str | None = None,
    cols: int = TMUX_DEFAULT_COLS,
    rows: int = TMUX_DEFAULT_ROWS,
) -> dict[str, Any]:
    """Ask Tether for a new session and show it in ``pane_id``.

    ``mode`` is ``shell`` or an agent tool slug or alias. Tether resolves the
    alias, launches the tool, and stores the canonical slug.
    """
    descriptor = get_client().create_session(
        origin=ORIGIN,
        cols=cols,
        rows=rows,
        tool=mode,
        project_id=project_id,
        project_root=working_dir,
        name=name,
        a_term_session_id=str(uuid.uuid4()),
    )
    session_id = str(descriptor["id"])
    canonical_mode = str(descriptor.get("tool") or mode)
    link = pane_store.link_session(session_id, pane_id, canonical_mode)
    logger.info(
        "session_created",
        session_id=session_id,
        pane_id=pane_id,
        mode=canonical_mode,
        project_id=project_id,
        status=descriptor.get("status"),
    )
    return session_catalog.from_tether(descriptor, link)


def create_pane_with_sessions(
    *,
    pane_type: str,
    pane_name: str,
    project_id: str | None = None,
    working_dir: str | None = None,
    agent_tool_slug: str | None = None,
    is_detached: bool = False,
    pane_order: int | None = None,
    width_percent: float | None = None,
    height_percent: float | None = None,
    grid_row: int | None = None,
    grid_col: int | None = None,
    include_shell: bool = True,
) -> dict[str, Any]:
    """Create a pane and its sessions: shell plus agent (project), or shell (ad hoc).

    If Tether refuses any session, the sessions already created are ended and
    the pane is removed, so a failed create leaves nothing behind.
    """
    agent_mode = (
        agent_tools.canonical_slug(agent_tool_slug) if agent_tool_slug else agent_tools.default_agent_slug()
    )
    active_mode = agent_mode if pane_type == "project" else SHELL_MODE
    pane = pane_store.create_pane(
        pane_type=pane_type,
        pane_name=pane_name,
        project_id=project_id,
        active_mode=active_mode,
        is_detached=is_detached,
        pane_order=pane_order,
        width_percent=width_percent,
        height_percent=height_percent,
        grid_row=grid_row,
        grid_col=grid_col,
    )
    modes: list[str] = []
    if include_shell or pane_type == "adhoc":
        modes.append(SHELL_MODE)
    if pane_type == "project" and agent_mode != SHELL_MODE:
        modes.append(agent_mode)
    created: list[dict[str, Any]] = []
    try:
        for mode in modes:
            created.append(
                create_session(
                    pane_id=pane["id"],
                    mode=mode,
                    project_id=project_id,
                    working_dir=working_dir,
                    name=None if project_id else pane_name,
                )
            )
    except Exception:
        for session in reversed(created):
            try:
                end_session(str(session["id"]))
            except Exception as error:  # pragma: no cover - best effort rollback
                logger.warning("pane_rollback_end_failed", session_id=session["id"], error=str(error))
        pane_store.delete_pane(pane["id"])
        raise
    if created and pane_type == "project":
        pane = pane_store.update_pane(pane["id"], active_mode=str(created[-1]["mode"])) or pane
    return {**pane, "sessions": created}


# ---------------------------------------------------------------------------
# End
# ---------------------------------------------------------------------------
def end_session(session_id: str) -> bool:
    """End a session (Tether or legacy) and drop its pane link.

    Returns False when the session was already gone. Tether's End is fenced by
    the generation read just before it; a changed generation is reported, not
    retried.
    """
    if session_catalog.is_legacy_id(session_id):
        ended = tmux.kill_legacy_session(session_id)
        pane_store.unlink_session(session_id)
        return ended
    if not session_catalog.is_tether_id(session_id):
        raise LifecycleError(400, "Only Tether and legacy A-Term sessions can be ended here")
    client = get_client()
    try:
        descriptor = client.get_session(session_id)
    except TetherError as error:
        if error.status == 404:
            pane_store.unlink_session(session_id)
            return False
        raise
    generation = descriptor.get("generation")
    if not isinstance(generation, str):
        raise LifecycleError(409, "The session has no generation yet; refresh and try again")
    try:
        client.end_session(session_id, generation)
    except TetherError as error:
        if error.status == 404:
            pane_store.unlink_session(session_id)
            return False
        raise
    pane_store.unlink_session(session_id)
    logger.info("session_ended", session_id=session_id)
    return True


def end_pane(pane_id: str) -> int:
    """End every session a pane shows, then delete the pane."""
    ended = 0
    for link in pane_store.links_for_pane(pane_id):
        if end_session(link["session_id"]):
            ended += 1
    pane_store.delete_pane(pane_id)
    return ended


# ---------------------------------------------------------------------------
# Respawn (explicit reset)
# ---------------------------------------------------------------------------
def _require_respawnable(session: dict[str, Any] | None, session_id: str) -> dict[str, Any]:
    if session is None:
        raise LifecycleError(404, f"Session {session_id} not found")
    if session.get("is_legacy"):
        raise LifecycleError(409, "This session predates Tether and is attach-only")
    if session.get("is_root"):
        raise LifecycleError(409, "A root session runs one launch; start a new root instead")
    if session.get("source") != "tether":
        raise LifecycleError(400, "External tmux sessions are read-only")
    return session


def reset_session(session_id: str) -> dict[str, Any]:
    """Replace the session's workload with a fresh one of the same tool."""
    session = _require_respawnable(session_catalog.get_session(session_id), session_id)
    descriptor = get_client().respawn_session(session_id, str(session.get("generation")))
    logger.info("session_respawned", session_id=session_id)
    return session_catalog.from_tether(descriptor, pane_store.get_link(session_id))


def load_tool(session_id: str, tool: str) -> dict[str, Any]:
    """Respawn the session with another tool and remember it on the link."""
    session = _require_respawnable(session_catalog.get_session(session_id), session_id)
    descriptor = get_client().load_tui(session_id, str(session.get("generation")), tool)
    canonical = str(descriptor.get("tool") or tool)
    pane_store.update_link(session_id, mode=canonical)
    return session_catalog.from_tether(descriptor, pane_store.get_link(session_id))


def reset_all_sessions() -> int:
    """Respawn every Tether session A-Term panes show (legacy and roots skipped)."""
    count = 0
    for link in pane_store.list_links():
        if link["kind"] != "tether":
            continue
        try:
            reset_session(link["session_id"])
            count += 1
        except (LifecycleError, TetherError) as error:
            logger.warning("reset_all_skipped", session_id=link["session_id"], error=str(error))
    logger.info("all_sessions_reset", count=count)
    return count


def project_links(project_id: str) -> list[dict[str, Any]]:
    """Links of every pane that belongs to ``project_id``."""
    links: list[dict[str, Any]] = []
    for pane in pane_store.list_panes(include_detached=True):
        if pane.get("project_id") == project_id:
            links.extend(pane_store.links_for_pane(pane["id"]))
    return links


def reset_project_sessions(project_id: str, working_dir: str | None = None) -> dict[str, str | None]:
    """Respawn the project's shell and agent sessions; create any that are missing."""
    agent_slug = agent_tools.default_agent_slug()
    result: dict[str, str | None] = {SHELL_MODE: None, agent_slug: None}
    known = session_catalog.sessions_by_id()
    pane_id: str | None = None
    for link in project_links(project_id):
        pane_id = pane_id or link["pane_id"]
        session = known.get(link["session_id"])
        mode = str((session or {}).get("mode") or link["mode"])
        if session is None or session.get("is_legacy") or session.get("is_root"):
            continue
        if mode in result and result[mode] is None:
            result[mode] = str(reset_session(link["session_id"])["id"])
    if pane_id is None:
        pane = create_pane_with_sessions(
            pane_type="project",
            pane_name=project_id,
            project_id=project_id,
            working_dir=working_dir,
            agent_tool_slug=agent_slug,
        )
        for session in pane["sessions"]:
            result[str(session["mode"])] = str(session["id"])
        return result
    for mode in (SHELL_MODE, agent_slug):
        if result.get(mode) is None:
            created = create_session(pane_id=pane_id, mode=mode, project_id=project_id, working_dir=working_dir)
            result[mode] = str(created["id"])
    return result


def disable_project_a_term(project_id: str) -> int:
    """End every session the project's panes show, delete the panes, disable the tab."""
    ended = 0
    for pane in pane_store.list_panes(include_detached=True):
        if pane.get("project_id") == project_id:
            ended += end_pane(pane["id"])
    settings_store.upsert_settings(project_id, enabled=False)
    logger.info("project_a_term_disabled", project_id=project_id, ended_sessions=ended)
    return ended


# ---------------------------------------------------------------------------
# View-state reconciliation
# ---------------------------------------------------------------------------
def reconcile_links(empty_pane_days: int = 7) -> dict[str, int]:
    """Drop pane links to sessions that ended; prune long-empty panes.

    Raises :class:`~a_term.tether.TetherUnavailable` when Tether is down: an
    unreachable Tether never counts as "every session ended".
    """
    tether_ids = {str(item["id"]) for item in session_catalog.list_tether_sessions() if item.get("id")}
    legacy_ids = tmux.list_tmux_sessions()
    stats = {"links": 0, "links_dropped": 0, "panes_pruned": 0}
    for link in pane_store.list_links():
        stats["links"] += 1
        alive = tether_ids if link["kind"] == "tether" else legacy_ids
        if link["session_id"] not in alive:
            pane_store.unlink_session(link["session_id"])
            stats["links_dropped"] += 1
            logger.info("view_link_dropped", session_id=link["session_id"], kind=link["kind"])
    stats["panes_pruned"] = pane_store.delete_empty_panes(empty_pane_days)
    return stats
