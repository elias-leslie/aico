"""Maintenance tidies A-Term's own view state; history stays in memory."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI

from a_term.services import lifecycle, maintenance
from a_term.services.upload_cleanup import UploadCleanupStats
from a_term.storage import panes as pane_store
from a_term.storage import project_settings

from .fake_tether import FakeTether


@pytest.fixture()
def tether(fake_tether: FakeTether, no_default_tmux: MagicMock) -> FakeTether:
    return fake_tether


@pytest.fixture()
def no_uploads():
    with patch("a_term.services.maintenance.cleanup_old_uploads", return_value=UploadCleanupStats()) as cleanup:
        yield cleanup


def _app() -> FastAPI:
    app = FastAPI()
    maintenance._set_status(app, **maintenance.build_initial_status())
    return app


async def test_cycle_reconciles_links_and_prunes_settings(tether: FakeTether, no_uploads: MagicMock) -> None:
    tether.state.projects = [{"id": "keep", "name": "Keep", "root": "/tmp", "lifecycle": None}]
    project_settings.upsert_settings("keep", enabled=True)
    project_settings.upsert_settings("gone", enabled=True)
    pane = pane_store.create_pane(pane_type="project", pane_name="P", project_id="keep")
    ended = lifecycle.create_session(pane_id=pane["id"], mode="shell")
    tether.end(ended["id"])
    app = _app()

    result = await maintenance.run_cycle(app, reason="manual")

    assert result["skipped"] is False
    assert result["reconciliation"]["links_dropped"] == 1
    assert result["default_agent_tool"] == "codex"
    assert result["project_count"] == 1
    assert result["orphaned_project_settings_deleted"] == 1
    assert list(project_settings.get_all_settings()) == ["keep"]
    status = maintenance.get_status(app)
    assert status["state"] == "idle" and status["last_error"] is None and status["runs"] == 1
    runs = maintenance.list_recent_runs(app)
    assert [run["status"] for run in runs] == ["success"]


async def test_empty_catalog_never_prunes_settings(tether: FakeTether, no_uploads: MagicMock) -> None:
    project_settings.upsert_settings("a", enabled=True)
    result = await maintenance.run_cycle(_app(), reason="manual")
    assert result["project_settings_cleanup_skipped"] is True
    assert project_settings.get_settings("a") is not None


async def test_concurrent_cycle_is_skipped(tether: FakeTether, no_uploads: MagicMock) -> None:
    app = _app()
    async with maintenance._cycle_lock:
        result = await maintenance.run_cycle(app, reason="interval")
    assert result["skipped"] is True and result["skip_reason"] == "already_running"
    assert maintenance.list_recent_runs(app)[0]["status"] == "skipped"


async def test_failure_is_recorded_and_raised(tether_down: str, no_default_tmux: MagicMock, no_uploads: MagicMock) -> None:
    app = _app()
    with pytest.raises(Exception):  # noqa: B017 - Tether unavailable
        await maintenance.run_cycle(app, reason="manual")
    status = maintenance.get_status(app)
    assert status["state"] == "idle" and status["last_error"]
    assert maintenance.list_recent_runs(app)[0]["status"] == "failed"
    assert not maintenance._cycle_lock.locked()


async def test_history_is_most_recent_first_and_limited(tether: FakeTether, no_uploads: MagicMock) -> None:
    app = _app()
    for _ in range(3):
        await maintenance.run_cycle(app, reason="manual")
    runs = maintenance.list_recent_runs(app, limit=2)
    assert [run["run_id"] for run in runs] == [3, 2]


async def test_start_scheduler_survives_startup_failure(tether_down: str, no_default_tmux: MagicMock, no_uploads: MagicMock) -> None:
    app = FastAPI()
    with patch("a_term.services.maintenance.MAINTENANCE_ENABLED", False):
        await maintenance.start_scheduler(app)
    assert maintenance.get_status(app)["last_error"]
    await maintenance.stop_scheduler(app)
