"""Tests for internal maintenance endpoints and status surfacing."""

from __future__ import annotations

from typing import cast
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _app(client: TestClient) -> FastAPI:
    """Return the underlying FastAPI app from a TestClient."""
    return cast(FastAPI, client.app)


def test_internal_maintenance_status_requires_token(test_app: TestClient) -> None:
    """Internal maintenance status rejects missing tokens."""
    response = test_app.get("/api/internal/maintenance")

    assert response.status_code == 403


def test_internal_maintenance_status_returns_app_state(test_app: TestClient) -> None:
    """Internal maintenance status returns the in-memory status payload."""
    _app(test_app).state.internal_token = "secret"
    _app(test_app).state.maintenance_status = {"state": "idle", "runs": 2}

    response = test_app.get(
        "/api/internal/maintenance",
        headers={"Authorization": "Bearer secret"},
    )

    assert response.status_code == 200
    assert response.json()["state"] == "idle"
    assert response.json()["runs"] == 2


def test_internal_maintenance_run_triggers_cycle(test_app: TestClient) -> None:
    """Manual maintenance endpoint runs a maintenance cycle."""
    _app(test_app).state.internal_token = "secret"
    with patch(
        "aterm.api.aterm.run_maintenance_cycle",
        new=AsyncMock(return_value={"reason": "manual", "skipped": False}),
    ) as mock_run:
        response = test_app.post(
            "/api/internal/maintenance/run",
            headers={"Authorization": "Bearer secret"},
        )

    assert response.status_code == 200
    assert response.json()["reason"] == "manual"
    mock_run.assert_awaited_once()


def test_internal_maintenance_runs_returns_history(test_app: TestClient) -> None:
    """Recent maintenance runs are exposed through the internal API."""
    _app(test_app).state.internal_token = "secret"
    runs = [
        {"id": "run-1", "status": "success", "reason": "startup"},
        {"id": "run-2", "status": "failed", "reason": "interval"},
    ]
    with patch("aterm.api.aterm.list_recent_maintenance_runs", return_value=runs) as mock_list:
        response = test_app.get(
            "/api/internal/maintenance/runs?limit=2",
            headers={"Authorization": "Bearer secret"},
        )

    assert response.status_code == 200
    assert response.json()["items"] == runs
    assert response.json()["total"] == 2
    mock_list.assert_called_once_with(limit=2)
