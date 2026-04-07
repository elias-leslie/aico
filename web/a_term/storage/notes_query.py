"""Read helpers for A-Term notes."""

from __future__ import annotations

from typing import Any

from .connection import get_cursor
from .notes_helpers import NoteType, normalize_project_scope, row_to_note

_SELECT_COLS = """
    SELECT id, project_scope, type, title, content, tags, pinned, metadata,
           created_at, updated_at
    FROM a_term_notes
"""


def get_note(note_id: str) -> dict[str, Any] | None:
    """Get a note by ID."""
    with get_cursor() as cur:
        cur.execute(_SELECT_COLS + "WHERE id = %s", (note_id,))
        row = cur.fetchone()
    return row_to_note(row) if row else None


def list_notes(
    *,
    project_scope: str | None = None,
    note_type: NoteType | None = None,
    tags: list[str] | None = None,
    search: str | None = None,
    pinned: bool | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """List notes with optional filters."""
    conditions: list[str] = []
    params: list[Any] = []

    if project_scope is not None:
        conditions.append("project_scope = %s")
        params.append(normalize_project_scope(project_scope))
    if note_type is not None:
        conditions.append("type = %s")
        params.append(note_type)
    if tags:
        conditions.append("tags @> %s::text[]")
        params.append(tags)
    if search:
        conditions.append("(title ILIKE %s OR content ILIKE %s)")
        params.extend([f"%{search}%", f"%{search}%"])
    if pinned is not None:
        conditions.append("pinned = %s")
        params.append(pinned)

    where = " WHERE " + " AND ".join(conditions) if conditions else ""
    query = _SELECT_COLS + where + " ORDER BY pinned DESC, updated_at DESC LIMIT %s OFFSET %s"
    params.extend([limit, offset])

    with get_cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall()
    return [row_to_note(row) for row in rows]


def count_notes(
    *,
    project_scope: str | None = None,
    note_type: NoteType | None = None,
    tags: list[str] | None = None,
    search: str | None = None,
    pinned: bool | None = None,
) -> int:
    """Count notes matching the supplied filters."""
    conditions: list[str] = []
    params: list[Any] = []

    if project_scope is not None:
        conditions.append("project_scope = %s")
        params.append(normalize_project_scope(project_scope))
    if note_type is not None:
        conditions.append("type = %s")
        params.append(note_type)
    if tags:
        conditions.append("tags @> %s::text[]")
        params.append(tags)
    if search:
        conditions.append("(title ILIKE %s OR content ILIKE %s)")
        params.extend([f"%{search}%", f"%{search}%"])
    if pinned is not None:
        conditions.append("pinned = %s")
        params.append(pinned)

    where = " WHERE " + " AND ".join(conditions) if conditions else ""
    query = "SELECT COUNT(*) FROM a_term_notes" + where

    with get_cursor() as cur:
        cur.execute(query, params)
        row = cur.fetchone()
    return row[0] if row else 0


def list_tags(project_scope: str | None = None) -> list[str]:
    """List distinct tags, optionally scoped."""
    if project_scope:
        query = (
            "SELECT DISTINCT unnest(tags) AS tag FROM a_term_notes "
            "WHERE project_scope = %s ORDER BY tag"
        )
        params: tuple[Any, ...] = (normalize_project_scope(project_scope),)
    else:
        query = "SELECT DISTINCT unnest(tags) AS tag FROM a_term_notes ORDER BY tag"
        params = ()

    with get_cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall()
    return [row[0] for row in rows]


def list_project_scopes() -> list[str]:
    """List distinct persisted local note scopes."""
    with get_cursor() as cur:
        cur.execute("SELECT DISTINCT project_scope FROM a_term_notes ORDER BY project_scope")
        rows = cur.fetchall()
    return list(
        dict.fromkeys(
            normalize_project_scope(row[0]) for row in rows if row and row[0]
        )
    )
