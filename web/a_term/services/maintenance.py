"""Periodic maintenance for A-Term's view state.

Tether owns sessions, so maintenance only tidies what A-Term keeps: pane
links to sessions that ended, panes left empty, old uploads and settings for
projects that no longer exist. Run history is kept in memory.
"""

from __future__ import annotations

import asyncio
from collections import deque
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
from ..storage import project_settings as project_settings_store
from . import agent_tools, lifecycle, project_catalog
from .upload_cleanup import cleanup_old_uploads

logger = get_logger(__name__)

MAINTENANCE_STATUS_ATTR = "maintenance_status"
MAINTENANCE_TASK_ATTR = "maintenance_task"
MAINTENANCE_HISTORY_ATTR = "maintenance_history"
_HISTORY_LIMIT = 100
_cycle_lock = asyncio.Lock()


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


def _history(app: FastAPI) -> deque[dict[str, Any]]:
    history = getattr(app.state, MAINTENANCE_HISTORY_ATTR, None)
    if history is None:
        history = deque(maxlen=_HISTORY_LIMIT)
        setattr(app.state, MAINTENANCE_HISTORY_ATTR, history)
    return history


def list_recent_runs(app: FastAPI, limit: int = 10) -> list[dict[str, Any]]:
    """Most recent runs first (in memory; lost on restart)."""
    return list(reversed(_history(app)))[:limit]


def _project_settings_cleanup(result: dict[str, Any]) -> None:
    projects = project_catalog.list_projects_sync()
    valid_project_ids = {str(project.get("id")) for project in projects if project.get("id")}
    result["project_count"] = len(valid_project_ids)
    if valid_project_ids:
        result["orphaned_project_settings_deleted"] = project_settings_store.prune_missing_projects(valid_project_ids)
    else:
        result["orphaned_project_settings_deleted"] = 0
        result["project_settings_cleanup_skipped"] = True


def _run_cycle_sync(reason: str, run_id: int) -> dict[str, Any]:
    reconciliation = lifecycle.reconcile_links(empty_pane_days=MAINTENANCE_SESSION_PURGE_DAYS)
    upload_cleanup_stats = cleanup_old_uploads()
    result: dict[str, Any] = {
        "run_id": run_id,
        "reason": reason,
        "skipped": False,
        "reconciliation": reconciliation,
        "upload_cleanup": upload_cleanup_stats.to_dict(),
    }
    result["default_agent_tool"] = agent_tools.default_agent_slug()
    _project_settings_cleanup(result)
    return result


async def run_cycle(app: FastAPI, reason: str) -> dict[str, Any]:
    """Run one maintenance pass; concurrent requests skip instead of queueing."""
    status = get_status(app)
    run_id = int(status.get("runs", 0)) + 1
    started_at = _now_iso()
    started_clock = perf_counter()
    if _cycle_lock.locked():
        result = {"run_id": run_id, "reason": reason, "skipped": True, "skip_reason": "already_running"}
        _history(app).append({**result, "status": "skipped", "started_at": started_at})
        logger.info("maintenance_cycle_skipped", reason=reason, skip_reason="already_running")
        return result
    async with _cycle_lock:
        _set_status(
            app,
            state="running",
            last_started_at=started_at,
            last_reason=reason,
            last_error=None,
            last_run_id=run_id,
            runs=run_id,
        )
        try:
            result = await asyncio.to_thread(_run_cycle_sync, reason, run_id)
        except Exception as exc:
            duration_ms = round((perf_counter() - started_clock) * 1000, 2)
            _history(app).append(
                {"run_id": run_id, "reason": reason, "status": "failed", "started_at": started_at,
                 "duration_ms": duration_ms, "error": str(exc)}
            )
            _set_status(
                app,
                state="idle",
                last_completed_at=_now_iso(),
                last_duration_ms=duration_ms,
                last_error=str(exc),
            )
            raise
        completed_at = _now_iso()
        duration_ms = round((perf_counter() - started_clock) * 1000, 2)
        _history(app).append(
            {"run_id": run_id, "reason": reason, "status": "success", "started_at": started_at,
             "completed_at": completed_at, "duration_ms": duration_ms, "result": result}
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
