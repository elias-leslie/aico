"""Periodic maintenance orchestration for the a_term service."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import UTC, datetime
from time import perf_counter
from typing import Any

from fastapi import FastAPI

from ..config import (
    MAINTENANCE_ENABLED,
    MAINTENANCE_INTERVAL_SECONDS,
    MAINTENANCE_SESSION_PURGE_DAYS,
)
from ..logging_config import get_logger
from ..storage import agent_tools as agent_tools_store
from ..storage import maintenance_runs as maintenance_run_store
from ..storage import project_settings as project_settings_store
from ..storage.connection import advisory_lock
from . import lifecycle, project_catalog
from .upload_cleanup import cleanup_old_uploads

logger = get_logger(__name__)

MAINTENANCE_STATUS_ATTR = "maintenance_status"
MAINTENANCE_TASK_ATTR = "maintenance_task"
_MAINTENANCE_LOCK_KEY = 8_002_101


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def build_initial_status() -> dict[str, Any]:
    """Return the initial in-memory maintenance status payload."""
    return {
        "enabled": MAINTENANCE_ENABLED,
        "interval_seconds": MAINTENANCE_INTERVAL_SECONDS,
        "session_purge_days": MAINTENANCE_SESSION_PURGE_DAYS,
        "state": "idle",
        "last_started_at": None,
        "last_completed_at": None,
        "last_success_at": None,
        "last_reason": None,
        "last_duration_ms": None,
        "last_result": None,
        "last_error": None,
        "last_run_id": None,
        "runs": 0,
    }


def _set_status(app: FastAPI, **updates: Any) -> dict[str, Any]:
    status = getattr(app.state, MAINTENANCE_STATUS_ATTR, build_initial_status())
    status.update(updates)
    setattr(app.state, MAINTENANCE_STATUS_ATTR, status)
    return status


def get_status(app: FastAPI) -> dict[str, Any]:
    """Return the current in-memory maintenance status."""
    return _set_status(app)


async def run_cycle(app: FastAPI, reason: str) -> dict[str, Any]:
    """Run one full maintenance pass with advisory-lock protection."""
    started_at = _now_iso()
    started_clock = perf_counter()
    run_id = maintenance_run_store.create_run(reason)
    runs = int(get_status(app).get("runs", 0)) + 1
    _set_status(
        app,
        state="running",
        last_started_at=started_at,
        last_reason=reason,
        last_error=None,
        last_run_id=run_id,
        runs=runs,
    )
    try:
        with advisory_lock(_MAINTENANCE_LOCK_KEY) as acquired:
            if not acquired:
                duration_ms = round((perf_counter() - started_clock) * 1000, 2)
                result = {
                    "run_id": run_id,
                    "reason": reason,
                    "skipped": True,
                    "skip_reason": "lock_not_acquired",
                }
                maintenance_run_store.complete_run(
                    run_id=run_id,
                    status="skipped",
                    duration_ms=duration_ms,
                )
                _set_status(
                    app,
                    state="idle",
                    last_completed_at=_now_iso(),
                    last_duration_ms=duration_ms,
                    last_result=result,
                )
                logger.info("maintenance_cycle_skipped", reason=reason, skip_reason="lock_not_acquired")
                return result

            reconciliation = lifecycle.reconcile_sessions(
                purge_after_days=MAINTENANCE_SESSION_PURGE_DAYS
            )
            upload_cleanup_stats = cleanup_old_uploads()
            result: dict[str, Any] = {
                "run_id": run_id,
                "reason": reason,
                "skipped": False,
                "reconciliation": reconciliation,
                "upload_cleanup": upload_cleanup_stats.to_dict(),
            }

            default_tool = agent_tools_store.ensure_default()
            result["default_agent_tool"] = default_tool["slug"] if default_tool else None

            projects = await project_catalog.list_projects()
            valid_project_ids = {str(project.get("id")) for project in projects if project.get("id")}
            result["project_count"] = len(valid_project_ids)
            if valid_project_ids:
                deleted = project_settings_store.prune_missing_projects(valid_project_ids)
                result["orphaned_project_settings_deleted"] = deleted
            else:
                result["orphaned_project_settings_deleted"] = 0
                result["project_settings_cleanup_skipped"] = True

        completed_at = _now_iso()
        duration_ms = round((perf_counter() - started_clock) * 1000, 2)
        maintenance_run_store.complete_run(
            run_id=run_id,
            status="success",
            duration_ms=duration_ms,
            reconciliation_purged=reconciliation.get("purged", 0),
            reconciliation_orphans_killed=reconciliation.get("orphans_killed", 0),
            upload_scanned_files=upload_cleanup_stats.scanned_files,
            upload_deleted_files=upload_cleanup_stats.deleted_files,
            upload_pruned_directories=upload_cleanup_stats.pruned_directories,
            upload_errors=upload_cleanup_stats.errors,
            orphaned_project_settings_deleted=result.get("orphaned_project_settings_deleted", 0),
            project_count=result.get("project_count", 0),
            default_agent_tool_slug=result.get("default_agent_tool"),
        )
        _set_status(
            app,
            state="idle",
            last_completed_at=completed_at,
            last_success_at=completed_at,
            last_duration_ms=duration_ms,
            last_result=result,
            last_error=None,
        )
        logger.info("maintenance_cycle_complete", duration_ms=duration_ms, **result)
        return result
    except Exception as exc:
        duration_ms = round((perf_counter() - started_clock) * 1000, 2)
        maintenance_run_store.complete_run(
            run_id=run_id,
            status="failed",
            duration_ms=duration_ms,
            error=str(exc),
        )
        _set_status(
            app,
            state="idle",
            last_completed_at=_now_iso(),
            last_duration_ms=duration_ms,
            last_error=str(exc),
        )
        raise


async def _maintenance_loop(app: FastAPI) -> None:
    """Periodic maintenance task."""
    try:
        while True:
            await asyncio.sleep(MAINTENANCE_INTERVAL_SECONDS)
            try:
                await run_cycle(app, reason="interval")
            except Exception as exc:
                _set_status(
                    app,
                    state="idle",
                    last_completed_at=_now_iso(),
                    last_error=str(exc),
                )
                logger.error("maintenance_cycle_failed", reason="interval", error=str(exc))
    except asyncio.CancelledError:
        logger.info("maintenance_loop_cancelled")
        raise


async def start_scheduler(app: FastAPI) -> None:
    """Initialize maintenance state, run startup maintenance, and start the loop."""
    _set_status(app, **build_initial_status())
    try:
        await run_cycle(app, reason="startup")
    except Exception as exc:
        _set_status(
            app,
            state="idle",
            last_completed_at=_now_iso(),
            last_error=str(exc),
        )
        logger.error("startup_maintenance_failed", error=str(exc))
    if MAINTENANCE_ENABLED:
        setattr(app.state, MAINTENANCE_TASK_ATTR, asyncio.create_task(_maintenance_loop(app)))


async def stop_scheduler(app: FastAPI) -> None:
    """Stop the periodic maintenance task if running."""
    task = getattr(app.state, MAINTENANCE_TASK_ATTR, None)
    if task is None:
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    setattr(app.state, MAINTENANCE_TASK_ATTR, None)
