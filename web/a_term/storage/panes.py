"""A-Term panes storage layer — CRUD and session-creation.

Ordering/layout: pane_layout.py. Session-fetch helpers: pane_sessions.py.
Re-exports everything so callers importing this module are unaffected.
"""

from __future__ import annotations

from typing import Any, Literal, cast

import psycopg.sql
from psycopg.rows import dict_row

from ..logging_config import get_logger
from ..utils.tmux import TmuxError, create_tmux_session, get_tmux_session_name, run_tmux_command
from . import agent_tools
from .connection import get_connection
from .pane_core import (
    PANE_FIELDS,
    PaneId,
    _execute_query,
    _execute_write,
    _normalize_pane_row,
    _prepare_pane_slot,
)
from .pane_layout import count_panes, swap_pane_positions, update_pane_layouts, update_pane_order
from .pane_sessions import fetch_sessions_for_pane, list_panes_with_sessions_data
from .sessions import create_session as create_a_term_session
from .sessions import delete_session as delete_a_term_session
from .sessions import get_session as get_a_term_session

logger = get_logger(__name__)
__all__ = [
    "PANE_FIELDS", "PaneId",
    "attach_pane", "count_panes", "create_pane_with_sessions", "delete_pane", "detach_pane",
    "fetch_sessions_for_pane", "get_pane", "get_pane_with_sessions", "list_panes",
    "list_panes_with_sessions", "swap_pane_positions", "update_pane", "update_pane_layouts",
    "update_pane_order",
]


def _get_default_agent_slug() -> str:
    """Get the default agent tool slug, falling back to 'claude'."""
    default = agent_tools.get_default()
    return default["slug"] if default else "claude"


def _create_tmux_backed_session(
    name: str,
    project_id: str | None,
    working_dir: str | None,
    mode: str,
    pane_id: str,
) -> dict[str, Any]:
    """Create a pane session and its tmux backing, rolling back DB on failure."""
    session_id = create_a_term_session(
        name=name, project_id=project_id, working_dir=working_dir, mode=mode, pane_id=pane_id,
    )
    try:
        create_tmux_session(session_id, working_dir)
    except TmuxError as err:
        logger.error("pane_session_tmux_create_failed", pane_id=pane_id, session_id=session_id, mode=mode, error=str(err))
        delete_a_term_session(session_id)
        raise
    session = get_a_term_session(session_id)
    if not session:
        raise ValueError(f"Created session {session_id} was not found")
    return session


def list_panes(include_detached: bool = False) -> list[dict[str, Any]]:
    """List panes ordered by pane_order."""
    query = (
        f"SELECT {PANE_FIELDS} FROM a_term_panes ORDER BY is_detached, pane_order, created_at"
        if include_detached
        else f"SELECT {PANE_FIELDS} FROM a_term_panes WHERE is_detached = false ORDER BY pane_order, created_at"
    )
    return cast(list[dict[str, Any]], _execute_query(query, (), fetch_mode="all"))


def get_pane(pane_id: PaneId) -> dict[str, Any] | None:
    """Get a pane by ID."""
    return cast(dict[str, Any] | None, _execute_query(f"SELECT {PANE_FIELDS} FROM a_term_panes WHERE id = %s", (str(pane_id),)))


def get_pane_with_sessions(pane_id: PaneId) -> dict[str, Any] | None:
    """Get a pane with its sessions."""
    pane = get_pane(pane_id)
    if not pane:
        return None
    pane["sessions"] = fetch_sessions_for_pane(pane_id)
    return pane


def list_panes_with_sessions(include_detached: bool = False) -> list[dict[str, Any]]:
    """List panes with their sessions."""
    panes = list_panes(include_detached=include_detached)
    if not panes:
        return []
    sessions_by_pane = list_panes_with_sessions_data([p["id"] for p in panes])
    for pane in panes:
        pane["sessions"] = sessions_by_pane.get(pane["id"], [])
    return panes


def create_pane_with_sessions(
    pane_type: Literal["project", "adhoc"],
    pane_name: str,
    project_id: str | None = None,
    working_dir: str | None = None,
    pane_order: int | None = None,
    agent_tool_slug: str | None = None,
) -> dict[str, Any]:
    """Create a pane and its tmux-backed sessions with rollback on failure."""
    if pane_type == "project" and not project_id:
        raise ValueError("project_id required for project panes")
    if pane_type == "adhoc" and project_id:
        raise ValueError("project_id must be None for adhoc panes")
    tool_slug = agent_tool_slug or _get_default_agent_slug()
    # New project panes should land in a guaranteed-working shell first.
    default_mode = "shell"
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        order = _prepare_pane_slot(cur, pane_order)
        cur.execute(
            f"INSERT INTO a_term_panes (pane_type, project_id, pane_order, pane_name, active_mode) VALUES (%s, %s, %s, %s, %s) RETURNING {PANE_FIELDS}",
            (pane_type, project_id, order, pane_name, default_mode),
        )
        pane_row = cur.fetchone()
        if not pane_row:
            raise ValueError("Failed to create pane")
        pane = _normalize_pane_row(pane_row)
        conn.commit()

    session_name = f"Project: {project_id}" if project_id else pane_name
    created_session_ids: list[str] = []
    sessions: list[dict[str, Any]] = []
    try:
        shell_session = _create_tmux_backed_session(
            session_name, project_id, working_dir, "shell", pane["id"],
        )
        created_session_ids.append(shell_session["id"])
        sessions.append(shell_session)
        if pane_type == "project":
            agent_session = _create_tmux_backed_session(
                session_name, project_id, working_dir, tool_slug, pane["id"],
            )
            created_session_ids.append(agent_session["id"])
            sessions.append(agent_session)
    except (TmuxError, ValueError):
        for sid in reversed(created_session_ids):
            run_tmux_command(["kill-session", "-t", get_tmux_session_name(sid)])
            delete_a_term_session(sid)
        delete_pane(pane["id"])
        raise

    pane["sessions"] = sessions
    return pane


def update_pane(pane_id: PaneId, **fields: Any) -> dict[str, Any] | None:
    """Update pane metadata."""
    allowed = {"pane_name", "pane_order", "active_mode", "is_detached", "width_percent", "height_percent", "grid_row", "grid_col"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return get_pane(pane_id)
    set_clauses = [psycopg.sql.SQL("{} = %s").format(psycopg.sql.Identifier(f)) for f in updates]
    query = psycopg.sql.SQL(
        f"UPDATE a_term_panes SET {{}} WHERE id = %s RETURNING {PANE_FIELDS}"
    ).format(psycopg.sql.SQL(", ").join(set_clauses))
    return _execute_write(query, [*updates.values(), str(pane_id)])


def delete_pane(pane_id: PaneId) -> bool:
    """Delete a pane and all its sessions (cascading)."""
    nid = str(pane_id)
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM a_term_sessions WHERE pane_id = %s", (nid,))
        cur.execute("DELETE FROM a_term_panes WHERE id = %s RETURNING id", (nid,))
        result = cur.fetchone()
        conn.commit()
    return result is not None


def detach_pane(pane_id: PaneId) -> dict[str, Any] | None:
    """Hide a pane from the active layout while preserving sessions."""
    return update_pane(pane_id, is_detached=True)


def attach_pane(pane_id: PaneId) -> dict[str, Any] | None:
    """Reattach a detached pane to the active layout."""
    nid = str(pane_id)
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        order = _prepare_pane_slot(cur)
        cur.execute(
            f"UPDATE a_term_panes SET is_detached = false, pane_order = %s WHERE id = %s RETURNING {PANE_FIELDS}",
            (order, nid),
        )
        row = cur.fetchone()
        conn.commit()
    return _normalize_pane_row(row) if row else None
