"""Per-project display settings (local view state).

Each project can be enabled for A-Term tabs and remembers its display order
and the mode (shell or an agent tool slug) its tab shows.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from .local_db import connect, now_iso, transaction

_COLUMNS = "project_id, enabled, active_mode, display_order, created_at, updated_at"


def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    settings = dict(row)
    settings["enabled"] = bool(settings["enabled"])
    return settings


def get_all_settings() -> dict[str, dict[str, Any]]:
    with connect() as db:
        rows = db.execute(
            f"SELECT {_COLUMNS} FROM project_settings ORDER BY display_order, project_id"
        ).fetchall()
    return {row["project_id"]: settings for row in rows if (settings := _row(row)) is not None}


def get_settings(project_id: str) -> dict[str, Any] | None:
    with connect() as db:
        return _row(db.execute(f"SELECT {_COLUMNS} FROM project_settings WHERE project_id = ?", (project_id,)).fetchone())


def upsert_settings(
    project_id: str,
    enabled: bool | None = None,
    active_mode: str | None = None,
    display_order: int | None = None,
) -> dict[str, Any]:
    """Create or update; only the given fields change on an existing row."""
    now = now_iso()
    with transaction() as db:
        existing = db.execute("SELECT 1 FROM project_settings WHERE project_id = ?", (project_id,)).fetchone()
        if existing is None:
            db.execute(
                f"INSERT INTO project_settings ({_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    project_id,
                    int(bool(enabled)) if enabled is not None else 0,
                    active_mode if active_mode is not None else "shell",
                    display_order if display_order is not None else 0,
                    now,
                    now,
                ),
            )
        else:
            updates: dict[str, Any] = {"updated_at": now}
            if enabled is not None:
                updates["enabled"] = int(bool(enabled))
            if active_mode is not None:
                updates["active_mode"] = active_mode
            if display_order is not None:
                updates["display_order"] = display_order
            assignments = ", ".join(f"{key} = ?" for key in updates)
            db.execute(
                f"UPDATE project_settings SET {assignments} WHERE project_id = ?",
                (*updates.values(), project_id),
            )
    settings = get_settings(project_id)
    if settings is None:
        raise ValueError(f"Failed to upsert settings for {project_id}")
    return settings


def bulk_update_order(project_ids: list[str]) -> None:
    """The index in ``project_ids`` becomes each project's display order."""
    if not project_ids:
        return
    now = now_iso()
    with transaction() as db:
        db.executemany(
            "UPDATE project_settings SET display_order = ?, updated_at = ? WHERE project_id = ?",
            [(index, now, project_id) for index, project_id in enumerate(project_ids)],
        )


def set_active_mode(project_id: str, mode: str) -> dict[str, Any] | None:
    with connect() as db:
        cursor = db.execute(
            "UPDATE project_settings SET active_mode = ?, updated_at = ? WHERE project_id = ?",
            (mode, now_iso(), project_id),
        )
    return get_settings(project_id) if cursor.rowcount else None


def prune_missing_projects(valid_project_ids: set[str]) -> int:
    """Delete settings for projects the active catalog no longer lists."""
    if not valid_project_ids:
        return 0
    placeholders = ", ".join("?" for _ in valid_project_ids)
    with connect() as db:
        cursor = db.execute(
            f"DELETE FROM project_settings WHERE project_id NOT IN ({placeholders})",
            tuple(sorted(valid_project_ids)),
        )
    return cursor.rowcount
