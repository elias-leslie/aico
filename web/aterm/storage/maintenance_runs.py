"""Persistence helpers for aterm maintenance run history."""

from __future__ import annotations

from typing import Any, Literal

from psycopg.rows import dict_row

from .connection import get_connection

MAINTENANCE_RUN_FIELDS = """
    id, reason, status, started_at, completed_at, duration_ms,
    reconciliation_purged, reconciliation_orphans_killed,
    upload_scanned_files, upload_deleted_files, upload_pruned_directories, upload_errors,
    orphaned_project_settings_deleted, project_count, default_agent_tool_slug,
    error, created_at, updated_at
"""

MaintenanceRunStatus = Literal["running", "success", "skipped", "failed"]


def create_run(reason: str) -> str:
    """Create a running maintenance run record and return its UUID."""
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO aterm_maintenance_runs (reason, status)
            VALUES (%s, 'running')
            RETURNING id
            """,
            (reason,),
        )
        row = cur.fetchone()
        conn.commit()
    if not row:
        raise ValueError("Failed to create maintenance run")
    return str(row[0])


def complete_run(
    run_id: str,
    status: MaintenanceRunStatus,
    *,
    duration_ms: float | None = None,
    reconciliation_purged: int = 0,
    reconciliation_orphans_killed: int = 0,
    upload_scanned_files: int = 0,
    upload_deleted_files: int = 0,
    upload_pruned_directories: int = 0,
    upload_errors: int = 0,
    orphaned_project_settings_deleted: int = 0,
    project_count: int = 0,
    default_agent_tool_slug: str | None = None,
    error: str | None = None,
) -> dict[str, Any] | None:
    """Finish a maintenance run with summary metrics."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"""
            UPDATE aterm_maintenance_runs
            SET status = %s,
                completed_at = NOW(),
                duration_ms = %s,
                reconciliation_purged = %s,
                reconciliation_orphans_killed = %s,
                upload_scanned_files = %s,
                upload_deleted_files = %s,
                upload_pruned_directories = %s,
                upload_errors = %s,
                orphaned_project_settings_deleted = %s,
                project_count = %s,
                default_agent_tool_slug = %s,
                error = %s,
                updated_at = NOW()
            WHERE id = %s
            RETURNING {MAINTENANCE_RUN_FIELDS}
            """,
            (
                status,
                duration_ms,
                reconciliation_purged,
                reconciliation_orphans_killed,
                upload_scanned_files,
                upload_deleted_files,
                upload_pruned_directories,
                upload_errors,
                orphaned_project_settings_deleted,
                project_count,
                default_agent_tool_slug,
                error,
                run_id,
            ),
        )
        row = cur.fetchone()
        conn.commit()
    return row


def list_recent_runs(limit: int = 10) -> list[dict[str, Any]]:
    """Return the most recent maintenance runs."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"""
            SELECT {MAINTENANCE_RUN_FIELDS}
            FROM aterm_maintenance_runs
            ORDER BY started_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        return cur.fetchall()
