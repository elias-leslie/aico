"""Session fetching helpers for pane storage."""

from __future__ import annotations

from typing import Any

from psycopg.rows import dict_row

from .connection import get_connection
from .pane_core import PaneId
from .sessions import A_TERM_SESSION_FIELDS, normalize_session_row


def fetch_sessions_for_pane(pane_id: PaneId, *, include_dead: bool = False) -> list[dict[str, Any]]:
    """Fetch sessions for a given pane."""
    alive_clause = "" if include_dead else " AND is_alive = true"
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"SELECT {A_TERM_SESSION_FIELDS} FROM a_term_sessions WHERE pane_id = %s{alive_clause} ORDER BY mode",
            (str(pane_id),),
        )
        return [normalize_session_row(row) for row in cur.fetchall()]


def list_panes_with_sessions_data(
    pane_ids: list[str],
    *,
    include_dead: bool = False,
) -> dict[str, list[dict[str, Any]]]:
    """Fetch sessions grouped by pane_id for a batch of panes."""
    if not pane_ids:
        return {}
    alive_clause = "" if include_dead else "AND is_alive = true"
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"""
            SELECT {A_TERM_SESSION_FIELDS}
            FROM a_term_sessions
            WHERE pane_id IS NOT NULL
              AND pane_id::text = ANY(%s)
              {alive_clause}
            ORDER BY pane_id, mode
            """,
            ([str(pane_id) for pane_id in pane_ids],),
        )
        sessions_by_pane: dict[str, list[dict[str, Any]]] = {}
        for row in cur.fetchall():
            session = normalize_session_row(row)
            pid = session["pane_id"]
            if pid:
                sessions_by_pane.setdefault(pid, []).append(session)
    return sessions_by_pane
