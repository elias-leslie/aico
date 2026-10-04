"""One durable request receipt per independently owned root session; no prompt storage."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from psycopg.rows import dict_row

from .connection import get_connection


def _normalize(row: dict[str, Any]) -> dict[str, Any]:
    return {**row, "session_id": str(row["session_id"]), "pane_id": str(row["pane_id"])}


def get(request_id: str) -> dict[str, Any] | None:
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT * FROM a_term_root_requests WHERE request_id = %s", (request_id,))
        row = cur.fetchone()
        return _normalize(row) if row else None


def for_session(session_id: str) -> dict[str, Any] | None:
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT * FROM a_term_root_requests WHERE session_id = %s", (session_id,))
        row = cur.fetchone()
        return _normalize(row) if row else None


def list_all() -> list[dict[str, Any]]:
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT * FROM a_term_root_requests ORDER BY created_at, request_id")
        return [_normalize(row) for row in cur.fetchall()]


def reserve(request: dict[str, Any], digest: str, mode: str) -> dict[str, Any]:
    """Atomically reserve request, pane and session. A competing retry uses the winner."""
    session_id, pane_id = str(uuid4()), str(uuid4())
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """INSERT INTO a_term_root_requests
               (request_id, digest, session_id, pane_id, logical_session_id, role,
                lead_root_reference, facet_capsule_ref)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (request_id) DO NOTHING RETURNING *""",
            (request["requestId"], digest, session_id, pane_id, f"a-term-root-{uuid4()}",
             request["role"], request["leadRootReference"], request["facetCapsuleRef"]),
        )
        row = cur.fetchone()
        if row:
            # Detached creation reuses the existing pane semantics without consuming a view slot.
            cur.execute("LOCK TABLE a_term_panes IN SHARE ROW EXCLUSIVE MODE")
            cur.execute(
                """INSERT INTO a_term_panes
                   (id, pane_type, project_id, pane_order, pane_name, active_mode, is_detached)
                   VALUES (%s, 'project', %s,
                           (SELECT COALESCE(MAX(pane_order), -1) + 1 FROM a_term_panes),
                           %s, %s, true)""",
                (pane_id, request["projectId"], f"Root: {request['requestId']}", mode),
            )
            cur.execute(
                """INSERT INTO a_term_sessions
                   (id, name, project_id, working_dir, mode, pane_id, claude_state)
                   VALUES (%s, %s, %s, %s, %s, %s, 'starting')""",
                (session_id, f"Root: {request['requestId']}", request["projectId"],
                 request["projectRoot"], mode, pane_id),
            )
        else:
            cur.execute("SELECT * FROM a_term_root_requests WHERE request_id = %s", (request["requestId"],))
            row = cur.fetchone()
        conn.commit()
        if row is None:
            raise RuntimeError("Root reservation missing")
        return _normalize(row)


def claim_launch(request_id: str) -> bool:
    """Commit the one launch attempt before invoking tmux; ambiguity never permits replay."""
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(
            """UPDATE a_term_root_requests SET launch_state = 'attempted'
               WHERE request_id = %s AND launch_state = 'reserved' RETURNING request_id""",
            (request_id,),
        )
        claimed = cur.fetchone() is not None
        conn.commit()
        return claimed


def observe(request_id: str, generation: str, process_pid: int, process_start_ticks: str) -> bool:
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(
            """UPDATE a_term_root_requests SET launch_state = 'observed', generation = %s,
               process_pid = %s, process_start_ticks = %s
               WHERE request_id = %s AND (generation IS NULL OR generation = %s)
                 AND launch_state IN ('attempted', 'observed') RETURNING request_id""",
            (generation, process_pid, process_start_ticks, request_id, generation),
        )
        observed = cur.fetchone() is not None
        conn.commit()
        return observed


def retire(root: dict[str, Any]) -> None:
    """Keep the terminal receipt; remove only its owned session and now-empty pane."""
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE a_term_root_requests SET launch_state = 'ended' WHERE request_id = %s", (root["request_id"],))
        cur.execute("DELETE FROM a_term_sessions WHERE id = %s", (root["session_id"],))
        cur.execute(
            """DELETE FROM a_term_panes WHERE id = %s
               AND NOT EXISTS (SELECT 1 FROM a_term_sessions WHERE pane_id = a_term_panes.id)""",
            (root["pane_id"],),
        )
        conn.commit()
