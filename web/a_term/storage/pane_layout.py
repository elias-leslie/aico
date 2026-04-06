"""Pane ordering and layout operations."""

from __future__ import annotations

from typing import Any

from psycopg.rows import dict_row

from .connection import get_connection
from .pane_core import PANE_FIELDS, PaneId, _normalize_pane_row


def update_pane_order(pane_orders: list[tuple[str, int]]) -> None:
    """Batch update pane ordering."""
    if not pane_orders:
        return
    with get_connection() as conn, conn.cursor() as cur:
        for pid, order in pane_orders:
            cur.execute("UPDATE a_term_panes SET pane_order = %s WHERE id = %s", (order, pid))
        conn.commit()


def swap_pane_positions(pane_id_a: PaneId, pane_id_b: PaneId) -> bool:
    """Swap positions of two panes."""
    a, b = str(pane_id_a), str(pane_id_b)
    if a == b:
        return True
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT id, pane_order FROM a_term_panes WHERE id IN (%s, %s)", (a, b))
        rows = cur.fetchall()
        if len(rows) != 2:
            return False
        orders = {str(row["id"]): row["pane_order"] for row in rows}
        cur.execute("UPDATE a_term_panes SET pane_order = %s WHERE id = %s", (orders[b], a))
        cur.execute("UPDATE a_term_panes SET pane_order = %s WHERE id = %s", (orders[a], b))
        conn.commit()
    return True


def count_panes(include_detached: bool = False) -> int:
    """Count panes, optionally including detached."""
    sql = "SELECT COUNT(*) FROM a_term_panes" + ("" if include_detached else " WHERE is_detached = false")
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(sql)
        row = cur.fetchone()
    return row[0] if row else 0


def update_pane_layouts(layouts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Batch update pane layout positions and sizes."""
    if not layouts:
        return []
    updated: list[dict[str, Any]] = []
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        for layout in layouts:
            pid = layout.get("pane_id")
            if not pid:
                continue
            cur.execute(
                f"""UPDATE a_term_panes
                    SET width_percent = COALESCE(%s, width_percent),
                        height_percent = COALESCE(%s, height_percent),
                        grid_row = COALESCE(%s, grid_row),
                        grid_col = COALESCE(%s, grid_col)
                    WHERE id = %s RETURNING {PANE_FIELDS}""",
                (layout.get("width_percent"), layout.get("height_percent"),
                 layout.get("grid_row"), layout.get("grid_col"), str(pid)),
            )
            row = cur.fetchone()
            if row:
                updated.append(_normalize_pane_row(row))
        conn.commit()
    return updated
