"""Tests for the maintenance orchestration service."""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI

from a_term.services.maintenance import (
    MAINTENANCE_STATUS_ATTR,
    build_initial_status,
    run_cycle,
    start_scheduler,
)
from a_term.services.upload_cleanup import UploadCleanupStats


@contextmanager
def _advisory_lock(acquired: bool):
    yield acquired


@pytest.mark.asyncio
async def test_run_cycle_updates_status_and_collects_results() -> None:
    """Maintenance cycle stores detailed success results on the app state."""
    app = FastAPI()
    setattr(app.state, MAINTENANCE_STATUS_ATTR, build_initial_status())

    with (
        patch("a_term.services.maintenance.advisory_lock", side_effect=lambda _key: _advisory_lock(True)),
        patch(
            "a_term.services.maintenance.lifecycle.reconcile_sessions",
            return_value={"purged": 2, "orphans_killed": 1},
        ),
        patch(
            "a_term.services.maintenance.cleanup_old_uploads",
            return_value=UploadCleanupStats(scanned_files=3, deleted_files=1, pruned_directories=1),
        ),
        patch(
            "a_term.services.maintenance.agent_tools_store.ensure_default",
            return_value={"slug": "codex"},
        ),
        patch(
            "a_term.services.maintenance.summitflow_client.list_projects",
            new=AsyncMock(return_value=[{"id": "a-term"}, {"id": "summitflow"}]),
        ),
        patch(
            "a_term.services.maintenance.project_settings_store.prune_missing_projects",
            return_value=1,
        ) as mock_prune,
        patch("a_term.services.maintenance.maintenance_run_store.create_run", return_value="run-1"),
        patch("a_term.services.maintenance.maintenance_run_store.complete_run") as mock_complete,
    ):
        result = await run_cycle(app, reason="manual")

    assert result["skipped"] is False
    assert result["run_id"] == "run-1"
    assert result["default_agent_tool"] == "codex"
    assert result["reconciliation"]["purged"] == 2
    assert result["upload_cleanup"]["deleted_files"] == 1
    status = getattr(app.state, MAINTENANCE_STATUS_ATTR)
    assert status["state"] == "idle"
    assert status["runs"] == 1
    assert status["last_success_at"] is not None
    assert status["last_result"] == result
    mock_prune.assert_called_once_with({"a-term", "summitflow"})
    mock_complete.assert_called_once()
    assert mock_complete.call_args.kwargs["run_id"] == "run-1"
    assert mock_complete.call_args.kwargs["status"] == "success"


@pytest.mark.asyncio
async def test_run_cycle_skips_when_lock_not_acquired() -> None:
    """Maintenance cycles are skipped instead of double-running when locked."""
    app = FastAPI()
    setattr(app.state, MAINTENANCE_STATUS_ATTR, build_initial_status())

    with (
        patch(
            "a_term.services.maintenance.advisory_lock",
            side_effect=lambda _key: _advisory_lock(False),
        ),
        patch("a_term.services.maintenance.maintenance_run_store.create_run", return_value="run-2"),
        patch("a_term.services.maintenance.maintenance_run_store.complete_run") as mock_complete,
    ):
        result = await run_cycle(app, reason="interval")

    assert result == {
        "run_id": "run-2",
        "reason": "interval",
        "skipped": True,
        "skip_reason": "lock_not_acquired",
    }
    status = getattr(app.state, MAINTENANCE_STATUS_ATTR)
    assert status["state"] == "idle"
    assert status["last_result"] == result
    assert status["last_success_at"] is None
    assert mock_complete.call_args.kwargs["status"] == "skipped"


@pytest.mark.asyncio
async def test_start_scheduler_records_startup_failure_without_task() -> None:
    """Startup failures are surfaced in maintenance status without crashing tests."""
    app = FastAPI()
    app.state = SimpleNamespace()  # type: ignore[assignment]

    with (
        patch("a_term.services.maintenance.run_cycle", new=AsyncMock(side_effect=RuntimeError("boom"))),
        patch("a_term.services.maintenance.MAINTENANCE_ENABLED", False),
    ):
        await start_scheduler(app)

    status = getattr(app.state, MAINTENANCE_STATUS_ATTR)
    assert status["state"] == "idle"
    assert status["last_error"] == "boom"
    assert not hasattr(app.state, "maintenance_task")


@pytest.mark.asyncio
async def test_run_cycle_persists_failed_runs() -> None:
    """Failures are written to maintenance run history before bubbling up."""
    app = FastAPI()
    setattr(app.state, MAINTENANCE_STATUS_ATTR, build_initial_status())

    with (
        patch("a_term.services.maintenance.advisory_lock", side_effect=lambda _key: _advisory_lock(True)),
        patch("a_term.services.maintenance.maintenance_run_store.create_run", return_value="run-3"),
        patch("a_term.services.maintenance.lifecycle.reconcile_sessions", side_effect=RuntimeError("bad reconcile")),
        patch("a_term.services.maintenance.maintenance_run_store.complete_run") as mock_complete,
        pytest.raises(RuntimeError, match="bad reconcile"),
    ):
        await run_cycle(app, reason="interval")

    status = getattr(app.state, MAINTENANCE_STATUS_ATTR)
    assert status["last_error"] == "bad reconcile"
    assert mock_complete.call_args.kwargs["run_id"] == "run-3"
    assert mock_complete.call_args.kwargs["status"] == "failed"
    assert mock_complete.call_args.kwargs["error"] == "bad reconcile"
