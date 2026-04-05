"""Session fetching helpers for pane storage."""

from __future__ import annotations

from typing import Any

from psycopg.rows import dict_row

from .connection import get_connection
from .pane_core import PaneId
from .sessions import ATERM_SESSION_FIELDS, normalize_session_row


def fetch_sessions_for_pane(pane_id: PaneId) -> list[dict[str, Any]]:
    """Fetch all sessions for a given pane."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"SELECT {ATERM_SESSION_FIELDS} FROM aterm_sessions WHERE pane_id = %s ORDER BY mode",
            (str(pane_id),),
        )
        return [normalize_session_row(row) for row in cur.fetchall()]


def list_panes_with_sessions_data(pane_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """Fetch all sessions grouped by pane_id for a batch of panes."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"SELECT {ATERM_SESSION_FIELDS} FROM aterm_sessions WHERE pane_id IS NOT NULL ORDER BY pane_id, mode"
        )
        sessions_by_pane: dict[str, list[dict[str, Any]]] = {}
        for row in cur.fetchall():
            session = normalize_session_row(row)
            pid = session["pane_id"]
            if pid:
                sessions_by_pane.setdefault(pid, []).append(session)
    return sessions_by_pane
