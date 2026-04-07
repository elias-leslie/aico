"""Version history for A-Term notes."""

from __future__ import annotations

from typing import Any

from .connection import generate_prefixed_id, get_connection, get_cursor

_SELECT_COLS = """
    SELECT id, note_id, version, title, content, tags, change_source, created_at
    FROM a_term_note_versions
"""


def _row_to_dict(row: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "id": row[0],
        "note_id": row[1],
        "version": row[2],
        "title": row[3],
        "content": row[4],
        "tags": row[5] or [],
        "change_source": row[6],
        "created_at": row[7],
    }


def create_version(
    note_id: str,
    title: str,
    content: str,
    tags: list[str] | None = None,
    change_source: str = "manual_edit",
) -> dict[str, Any]:
    """Snapshot the current state of a note."""
    version_id = generate_prefixed_id("nver")
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM a_term_note_versions WHERE note_id = %s",
            (note_id,),
        )
        row = cur.fetchone()
        version_num = row[0] if row else 1
        cur.execute(
            """
            INSERT INTO a_term_note_versions (id, note_id, version, title, content, tags, change_source)
            VALUES (%s, %s, %s, %s, %s, %s::text[], %s)
            RETURNING id, note_id, version, title, content, tags, change_source, created_at
            """,
            (version_id, note_id, version_num, title, content, tags or [], change_source),
        )
        result = cur.fetchone()
        conn.commit()
    if result is None:
        raise RuntimeError("Failed to create note version")
    return _row_to_dict(result)


def list_versions(note_id: str, limit: int = 50) -> list[dict[str, Any]]:
    """List versions newest first."""
    with get_cursor() as cur:
        cur.execute(
            _SELECT_COLS + "WHERE note_id = %s ORDER BY version DESC LIMIT %s",
            (note_id, limit),
        )
        rows = cur.fetchall()
    return [_row_to_dict(row) for row in rows]


def get_latest_version(note_id: str) -> dict[str, Any] | None:
    """Get the latest version for a note."""
    with get_cursor() as cur:
        cur.execute(
            _SELECT_COLS + "WHERE note_id = %s ORDER BY version DESC LIMIT 1",
            (note_id,),
        )
        row = cur.fetchone()
    return _row_to_dict(row) if row else None


def get_version(version_id: str) -> dict[str, Any] | None:
    """Get one version by ID."""
    with get_cursor() as cur:
        cur.execute(_SELECT_COLS + "WHERE id = %s", (version_id,))
        row = cur.fetchone()
    return _row_to_dict(row) if row else None
