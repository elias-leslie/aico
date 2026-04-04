"""Core types, field definitions, and low-level helpers for pane storage."""

from __future__ import annotations

from typing import Any, Literal, LiteralString, cast
from uuid import UUID

from psycopg.rows import dict_row

from ..constants import MAX_PANES
from .connection import get_connection

# ---------------------------------------------------------------------------
# Types & field lists
# ---------------------------------------------------------------------------
PaneId = str | UUID

PANE_FIELDS = """id, pane_type, project_id, pane_order, pane_name, active_mode, is_detached, created_at,
       width_percent, height_percent, grid_row, grid_col"""


def _normalize_pane_row(row: dict[str, Any]) -> dict[str, Any]:
    """Normalize pane row UUID to string in place and return the row."""
    row["id"] = str(row["id"])
    return row


def _execute_query(
    query: str, params: tuple[Any, ...] = (), *, fetch_mode: Literal["one", "all"] = "one"
) -> dict[str, Any] | list[dict[str, Any]] | None:
    """Execute a pane query and return normalized dict(s)."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(cast(LiteralString, query), params)
        if fetch_mode == "one":
            row = cur.fetchone()
            return _normalize_pane_row(row) if row else None
        return [_normalize_pane_row(row) for row in cur.fetchall()]


def _execute_write(query: Any, params: Any) -> dict[str, Any] | None:
    """Execute a write query, commit, and return a normalized pane row."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(query, params)
        row = cur.fetchone()
        conn.commit()
    return _normalize_pane_row(row) if row else None


def _prepare_pane_slot(cur: Any, pane_order: int | None = None) -> int:
    """Lock table, enforce pane limit, and return the next available pane_order."""
    cur.execute("LOCK TABLE terminal_panes IN SHARE ROW EXCLUSIVE MODE")
    cur.execute("SELECT COUNT(*) AS cnt FROM terminal_panes WHERE is_detached = false")
    row = cur.fetchone()
    if row and int(row["cnt"]) >= MAX_PANES:
        raise ValueError(f"Maximum {MAX_PANES} panes allowed. Close one to add more.")
    if pane_order is not None:
        return pane_order
    cur.execute(
        "SELECT COALESCE(MAX(pane_order), -1) + 1 AS next_order FROM terminal_panes WHERE is_detached = false"
    )
    row = cur.fetchone()
    return row["next_order"] if row else 0
