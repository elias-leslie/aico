"""A-Term sessions storage layer.

All session CRUD, lifecycle, project-scoped, and agent-state operations
in one module. The database is the source of truth; tmux is an
implementation detail managed by the services layer.
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, LiteralString, cast, overload
from uuid import UUID

import psycopg.sql
from psycopg.rows import dict_row

from ..logging_config import get_logger
from .connection import get_connection

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------
SessionId = str | UUID


def _to_str(session_id: SessionId) -> str:
    """Normalize session ID to string for SQL queries."""
    return str(session_id)


# ---------------------------------------------------------------------------
# Field lists & row conversion
# ---------------------------------------------------------------------------
A_TERM_SESSION_FIELDS = """id, name, user_id, project_id, working_dir, display_order,
               mode, session_number, is_alive, created_at, last_accessed_at,
               last_claude_session, claude_state, pane_id"""

_QUALIFIED_FIELDS = """a_term_sessions.id, a_term_sessions.name,
               a_term_sessions.user_id, a_term_sessions.project_id,
               a_term_sessions.working_dir, a_term_sessions.display_order,
               a_term_sessions.mode, a_term_sessions.session_number,
               a_term_sessions.is_alive, a_term_sessions.created_at,
               a_term_sessions.last_accessed_at, a_term_sessions.last_claude_session,
               a_term_sessions.claude_state, a_term_sessions.pane_id"""


def normalize_session_row(row: dict[str, Any]) -> dict[str, Any]:
    """Normalize a dict_row session for JSON serialization.

    Converts UUIDs to strings and datetimes to ISO format strings.
    All session queries should SELECT A_TERM_SESSION_FIELDS and pass results through this.
    """
    row["id"] = str(row["id"])
    if row.get("pane_id") is not None:
        row["pane_id"] = str(row["pane_id"])
    if row.get("created_at") is not None:
        row["created_at"] = row["created_at"].isoformat()
    if row.get("last_accessed_at") is not None:
        row["last_accessed_at"] = row["last_accessed_at"].isoformat()
    agent_state = row.get("agent_state") or row.get("claude_state") or "not_started"
    row["agent_state"] = agent_state
    row["claude_state"] = agent_state
    return row


@overload
def _execute_query(
    query: str, params: tuple[Any, ...] = (), *, fetch_mode: Literal["one"] = "one"
) -> dict[str, Any] | None: ...


@overload
def _execute_query(
    query: str, params: tuple[Any, ...] = (), *, fetch_mode: Literal["all"]
) -> list[dict[str, Any]]: ...


def _execute_query(
    query: str, params: tuple[Any, ...] = (), *, fetch_mode: Literal["one", "all"] = "one"
) -> dict[str, Any] | list[dict[str, Any]] | None:
    """Execute a session query and return normalized dict(s)."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(cast(LiteralString, query), params)
        if fetch_mode == "one":
            row = cur.fetchone()
            return normalize_session_row(row) if row else None
        return [normalize_session_row(row) for row in cur.fetchall()]


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------
def list_sessions(include_dead: bool = False, include_detached: bool = True) -> list[dict[str, Any]]:
    """List a_term sessions, optionally filtering dead/detached."""
    conditions: list[str] = []
    if not include_dead:
        conditions.append("a_term_sessions.is_alive = true")
    if not include_detached:
        conditions.append("COALESCE(a_term_panes.is_detached, false) = false")

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    query = f"""
        SELECT {_QUALIFIED_FIELDS}
        FROM a_term_sessions
        LEFT JOIN a_term_panes ON a_term_panes.id = a_term_sessions.pane_id
        {where}
        ORDER BY a_term_sessions.display_order, a_term_sessions.created_at
    """
    return _execute_query(query, (), fetch_mode="all")


def get_session(session_id: SessionId) -> dict[str, Any] | None:
    """Get a session by ID."""
    query = f"SELECT {A_TERM_SESSION_FIELDS} FROM a_term_sessions WHERE id = %s"
    return _execute_query(query, (_to_str(session_id),))


def create_session(
    name: str,
    project_id: str | None = None,
    working_dir: str | None = None,
    user_id: str | None = None,
    mode: str = "shell",
    pane_id: str | None = None,
) -> str:
    """Create a new a_term session. Returns server-generated UUID."""
    with get_connection() as conn, conn.cursor() as cur:
        if project_id:
            cur.execute(
                """
                INSERT INTO a_term_sessions
                    (name, user_id, project_id, working_dir, mode, session_number, pane_id)
                VALUES (
                    %s, %s, %s, %s, %s,
                    (SELECT COALESCE(MAX(session_number), 0) + 1
                     FROM a_term_sessions
                     WHERE project_id = %s AND mode = %s AND is_alive = true),
                    %s
                )
                RETURNING id
                """,
                (name, user_id, project_id, working_dir, mode, project_id, mode, pane_id),
            )
        else:
            cur.execute(
                """
                INSERT INTO a_term_sessions
                    (name, user_id, project_id, working_dir, mode, session_number, pane_id)
                VALUES (%s, %s, %s, %s, %s, 1, %s)
                RETURNING id
                """,
                (name, user_id, None, working_dir, mode, pane_id),
            )
        row = cur.fetchone()
        conn.commit()

    if not row:
        raise ValueError("Failed to create a_term session")
    return str(row[0])


def update_session(session_id: SessionId, **fields: Any) -> dict[str, Any] | None:
    """Update session metadata. Allowed: name, display_order, is_alive, working_dir."""
    allowed_fields = {"name", "display_order", "is_alive", "working_dir"}
    unknown_fields = set(fields.keys()) - allowed_fields
    if unknown_fields:
        logger.warning("update_session_unknown_fields", session_id=str(session_id), fields=list(unknown_fields))
    update_fields = {k: v for k, v in fields.items() if k in allowed_fields}

    if not update_fields:
        return get_session(session_id)

    set_clauses = [
        psycopg.sql.SQL("{} = %s").format(psycopg.sql.Identifier(field)) for field in update_fields
    ]
    values = list(update_fields.values())
    values.append(_to_str(session_id))

    query = psycopg.sql.SQL(
        f"""
        UPDATE a_term_sessions
        SET {{}}
        WHERE id = %s
        RETURNING {A_TERM_SESSION_FIELDS}
    """
    ).format(psycopg.sql.SQL(", ").join(set_clauses))

    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(query, values)
        row = cur.fetchone()
        conn.commit()

    return normalize_session_row(row) if row else None


def delete_session(session_id: SessionId) -> bool:
    """Hard-delete a session. Returns True if deleted."""
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(
            "DELETE FROM a_term_sessions WHERE id = %s RETURNING id",
            (_to_str(session_id),),
        )
        result = cur.fetchone()
        conn.commit()
    return result is not None


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------
def mark_dead(session_id: SessionId) -> dict[str, Any] | None:
    """Mark a session as dead (tmux no longer exists). Record preserved for recovery."""
    return update_session(session_id, is_alive=False)


def purge_dead_sessions(
    older_than_days: int = 7,
    exclude_session_ids: Collection[str] | None = None,
) -> int:
    """Permanently delete dead sessions older than N days."""
    cutoff = datetime.now(UTC) - timedelta(days=older_than_days)
    excluded = list(exclude_session_ids or [])

    with get_connection() as conn, conn.cursor() as cur:
        if excluded:
            cur.execute(
                """
                DELETE FROM a_term_sessions
                WHERE is_alive = false
                  AND last_accessed_at < %s
                  AND NOT (id::text = ANY(%s))
                """,
                (cutoff, excluded),
            )
        else:
            cur.execute(
                "DELETE FROM a_term_sessions WHERE is_alive = false AND last_accessed_at < %s",
                (cutoff,),
            )
        deleted_count = cur.rowcount
        conn.commit()
    return deleted_count


def touch_session(session_id: SessionId) -> dict[str, Any] | None:
    """Update last_accessed_at. Call on WebSocket connect."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"""
            UPDATE a_term_sessions SET last_accessed_at = NOW()
            WHERE id = %s RETURNING {A_TERM_SESSION_FIELDS}
            """,
            (_to_str(session_id),),
        )
        row = cur.fetchone()
        conn.commit()
    return normalize_session_row(row) if row else None


# ---------------------------------------------------------------------------
# Project-scoped queries
# ---------------------------------------------------------------------------
def get_all_project_sessions(project_id: str) -> list[dict[str, Any]]:
    """Get ALL alive sessions for a project (including duplicates). Used for cleanup."""
    query = f"""
        SELECT {A_TERM_SESSION_FIELDS}
        FROM a_term_sessions
        WHERE project_id = %s AND is_alive = true
        ORDER BY created_at
    """
    return _execute_query(query, (project_id,), fetch_mode="all")


def claim_dead_session_by_project(project_id: str, mode: str) -> dict[str, Any] | None:
    """Atomically claim a dead session for resurrection (UPDATE...WHERE prevents TOCTOU)."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"""
            UPDATE a_term_sessions
            SET is_alive = true
            WHERE id = (
                SELECT id FROM a_term_sessions
                WHERE project_id = %s AND mode = %s AND is_alive = false
                ORDER BY last_accessed_at DESC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING {A_TERM_SESSION_FIELDS}
            """,
            (project_id, mode),
        )
        row = cur.fetchone()
        conn.commit()
    return normalize_session_row(row) if row else None


# ---------------------------------------------------------------------------
# Agent (Claude) state
# ---------------------------------------------------------------------------
def update_claude_session(session_id: SessionId, claude_session: str | None) -> None:
    """Update the last active Claude session for a a_term."""
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE a_term_sessions SET last_claude_session = NULLIF(%s, '') WHERE id = %s",
            (claude_session or "", _to_str(session_id)),
        )
        conn.commit()


def update_claude_state(
    session_id: SessionId,
    state: str,
    expected_state: str | None = None,
) -> bool:
    """Update Claude state, optionally with conditional check. Returns True if applied."""
    with get_connection() as conn, conn.cursor() as cur:
        if expected_state is not None:
            cur.execute(
                "UPDATE a_term_sessions SET claude_state = %s WHERE id = %s AND claude_state = %s RETURNING id",
                (state, _to_str(session_id), expected_state),
            )
        else:
            cur.execute(
                "UPDATE a_term_sessions SET claude_state = %s WHERE id = %s RETURNING id",
                (state, _to_str(session_id)),
            )
        result = cur.fetchone()
        conn.commit()
    return result is not None


def get_claude_state(session_id: SessionId) -> str | None:
    """Get the current Claude state for a session."""
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT claude_state FROM a_term_sessions WHERE id = %s",
            (_to_str(session_id),),
        )
        row = cur.fetchone()
    return (row[0] or "not_started") if row else None
