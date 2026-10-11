"""Pane view state: panes, their layout, and which sessions each pane shows.

Pure local storage. Session lifecycle lives in Tether (see
``services/lifecycle.py``); this module never starts or ends anything.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from ..constants import MAX_PANES
from .local_db import connect, new_id, now_iso, transaction

PaneType = Literal["project", "adhoc"]
LinkKind = Literal["tether", "legacy"]

_PANE_COLUMNS = (
    "id, pane_type, project_id, pane_order, pane_name, active_mode, is_detached, created_at, "
    "width_percent, height_percent, grid_row, grid_col"
)
_UPDATABLE = {
    "pane_name",
    "pane_order",
    "active_mode",
    "is_detached",
    "width_percent",
    "height_percent",
    "grid_row",
    "grid_col",
}


def _pane(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    pane = dict(row)
    pane["is_detached"] = bool(pane["is_detached"])
    return pane


def _link(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


# ---------------------------------------------------------------------------
# Panes
# ---------------------------------------------------------------------------
def list_panes(include_detached: bool = False) -> list[dict[str, Any]]:
    where = "" if include_detached else "WHERE is_detached = 0"
    with connect() as db:
        rows = db.execute(
            f"SELECT {_PANE_COLUMNS} FROM panes {where} ORDER BY is_detached, pane_order, created_at"
        ).fetchall()
    return [pane for row in rows if (pane := _pane(row)) is not None]


def get_pane(pane_id: str) -> dict[str, Any] | None:
    with connect() as db:
        return _pane(db.execute(f"SELECT {_PANE_COLUMNS} FROM panes WHERE id = ?", (str(pane_id),)).fetchone())


def _visible_linked_count(db: sqlite3.Connection) -> int:
    row = db.execute(
        """SELECT COUNT(*) FROM panes p WHERE p.is_detached = 0
           AND EXISTS (SELECT 1 FROM pane_sessions s WHERE s.pane_id = p.id)"""
    ).fetchone()
    return int(row[0]) if row else 0


def _next_order(db: sqlite3.Connection, *, detached_too: bool) -> int:
    where = "" if detached_too else "WHERE is_detached = 0"
    row = db.execute(f"SELECT COALESCE(MAX(pane_order), -1) + 1 FROM panes {where}").fetchone()
    return int(row[0]) if row else 0


def create_pane(
    *,
    pane_type: PaneType,
    pane_name: str,
    project_id: str | None = None,
    active_mode: str = "shell",
    is_detached: bool = False,
    pane_order: int | None = None,
    width_percent: float | None = None,
    height_percent: float | None = None,
    grid_row: int | None = None,
    grid_col: int | None = None,
) -> dict[str, Any]:
    """Insert a pane. A visible pane counts against :data:`MAX_PANES`."""
    if pane_type == "project" and not project_id:
        raise ValueError("project_id required for project panes")
    if pane_type == "adhoc" and project_id:
        raise ValueError("project_id must be None for adhoc panes")
    pane_id = new_id()
    with transaction() as db:
        if not is_detached and _visible_linked_count(db) >= MAX_PANES:
            raise ValueError(f"Maximum {MAX_PANES} panes allowed. Close one to add more.")
        order = pane_order if pane_order is not None else _next_order(db, detached_too=is_detached)
        db.execute(
            """INSERT INTO panes (id, pane_type, project_id, pane_order, pane_name, active_mode,
                   is_detached, created_at, width_percent, height_percent, grid_row, grid_col)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                pane_id,
                pane_type,
                project_id,
                order,
                pane_name,
                active_mode,
                int(is_detached),
                now_iso(),
                100.0 if width_percent is None else width_percent,
                100.0 if height_percent is None else height_percent,
                0 if grid_row is None else grid_row,
                0 if grid_col is None else grid_col,
            ),
        )
    pane = get_pane(pane_id)
    if pane is None:
        raise ValueError("Failed to create pane")
    return pane


def update_pane(pane_id: str, **fields: Any) -> dict[str, Any] | None:
    updates = {key: value for key, value in fields.items() if key in _UPDATABLE}
    if "is_detached" in updates:
        updates["is_detached"] = int(bool(updates["is_detached"]))
    if updates:
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with connect() as db:
            db.execute(f"UPDATE panes SET {assignments} WHERE id = ?", (*updates.values(), str(pane_id)))
    return get_pane(pane_id)


def delete_pane(pane_id: str) -> bool:
    """Delete a pane and its session links (never the sessions themselves)."""
    with connect() as db:
        cursor = db.execute("DELETE FROM panes WHERE id = ?", (str(pane_id),))
    return cursor.rowcount > 0


def detach_pane(pane_id: str) -> dict[str, Any] | None:
    return update_pane(pane_id, is_detached=True)


def attach_pane(
    pane_id: str,
    pane_order: int | None = None,
    width_percent: float | None = None,
    height_percent: float | None = None,
    grid_row: int | None = None,
    grid_col: int | None = None,
) -> dict[str, Any] | None:
    """Return a detached pane to the visible layout, respecting :data:`MAX_PANES`."""
    with transaction() as db:
        if _visible_linked_count(db) >= MAX_PANES:
            raise ValueError(f"Maximum {MAX_PANES} panes allowed. Close one to add more.")
        order = pane_order if pane_order is not None else _next_order(db, detached_too=False)
        db.execute(
            """UPDATE panes SET is_detached = 0, pane_order = ?,
                   width_percent = COALESCE(?, width_percent),
                   height_percent = COALESCE(?, height_percent),
                   grid_row = COALESCE(?, grid_row),
                   grid_col = COALESCE(?, grid_col)
               WHERE id = ?""",
            (order, width_percent, height_percent, grid_row, grid_col, str(pane_id)),
        )
    return get_pane(pane_id)


def update_pane_order(pane_orders: list[tuple[str, int]]) -> None:
    if not pane_orders:
        return
    with transaction() as db:
        db.executemany("UPDATE panes SET pane_order = ? WHERE id = ?", [(order, str(pid)) for pid, order in pane_orders])


def swap_pane_positions(pane_id_a: str, pane_id_b: str) -> bool:
    a, b = str(pane_id_a), str(pane_id_b)
    if a == b:
        return True
    with transaction() as db:
        rows = db.execute("SELECT id, pane_order FROM panes WHERE id IN (?, ?)", (a, b)).fetchall()
        if len(rows) != 2:
            return False
        orders = {row["id"]: row["pane_order"] for row in rows}
        db.execute("UPDATE panes SET pane_order = ? WHERE id = ?", (orders[b], a))
        db.execute("UPDATE panes SET pane_order = ? WHERE id = ?", (orders[a], b))
    return True


def count_panes(include_detached: bool = False) -> int:
    detached = "" if include_detached else "AND p.is_detached = 0"
    with connect() as db:
        row = db.execute(
            f"""SELECT COUNT(*) FROM panes p
                WHERE EXISTS (SELECT 1 FROM pane_sessions s WHERE s.pane_id = p.id) {detached}"""
        ).fetchone()
    return int(row[0]) if row else 0


def update_pane_layouts(layouts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    updated: list[dict[str, Any]] = []
    with transaction() as db:
        for layout in layouts:
            pane_id = layout.get("pane_id")
            if not pane_id:
                continue
            db.execute(
                """UPDATE panes SET width_percent = COALESCE(?, width_percent),
                       height_percent = COALESCE(?, height_percent),
                       grid_row = COALESCE(?, grid_row),
                       grid_col = COALESCE(?, grid_col)
                   WHERE id = ?""",
                (
                    layout.get("width_percent"),
                    layout.get("height_percent"),
                    layout.get("grid_row"),
                    layout.get("grid_col"),
                    str(pane_id),
                ),
            )
            row = db.execute(f"SELECT {_PANE_COLUMNS} FROM panes WHERE id = ?", (str(pane_id),)).fetchone()
            pane = _pane(row)
            if pane:
                updated.append(pane)
    return updated


def delete_empty_panes(older_than_days: int) -> int:
    """Delete panes that show no session and are older than the cutoff."""
    cutoff = (datetime.now(UTC) - timedelta(days=older_than_days)).isoformat()
    with connect() as db:
        cursor = db.execute(
            """DELETE FROM panes WHERE created_at < ?
               AND NOT EXISTS (SELECT 1 FROM pane_sessions s WHERE s.pane_id = panes.id)""",
            (cutoff,),
        )
    return cursor.rowcount


# ---------------------------------------------------------------------------
# Session links
# ---------------------------------------------------------------------------
def link_session(
    session_id: str,
    pane_id: str,
    mode: str,
    *,
    kind: LinkKind = "tether",
    display_order: int = 0,
) -> dict[str, Any]:
    """Show ``session_id`` in ``pane_id``. A session belongs to at most one pane."""
    now = now_iso()
    with connect() as db:
        db.execute(
            """INSERT INTO pane_sessions (session_id, pane_id, mode, kind, display_order, created_at, last_accessed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (session_id) DO UPDATE SET pane_id = excluded.pane_id, mode = excluded.mode""",
            (str(session_id), str(pane_id), mode, kind, display_order, now, now),
        )
    link = get_link(session_id)
    if link is None:
        raise ValueError("Failed to link session")
    return link


def unlink_session(session_id: str) -> bool:
    with connect() as db:
        cursor = db.execute("DELETE FROM pane_sessions WHERE session_id = ?", (str(session_id),))
    return cursor.rowcount > 0


def get_link(session_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM pane_sessions WHERE session_id = ?", (str(session_id),)).fetchone()
    return _link(row) if row else None


def list_links() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM pane_sessions ORDER BY pane_id, mode").fetchall()
    return [_link(row) for row in rows]


def links_for_pane(pane_id: str) -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM pane_sessions WHERE pane_id = ? ORDER BY mode", (str(pane_id),)
        ).fetchall()
    return [_link(row) for row in rows]


def update_link(session_id: str, **fields: Any) -> None:
    allowed = {"mode", "display_order"}
    updates = {key: value for key, value in fields.items() if key in allowed}
    if not updates:
        return
    assignments = ", ".join(f"{key} = ?" for key in updates)
    with connect() as db:
        db.execute(
            f"UPDATE pane_sessions SET {assignments} WHERE session_id = ?",
            (*updates.values(), str(session_id)),
        )


def touch_link(session_id: str) -> None:
    with connect() as db:
        db.execute(
            "UPDATE pane_sessions SET last_accessed_at = ? WHERE session_id = ?",
            (now_iso(), str(session_id)),
        )
