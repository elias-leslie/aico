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
        "a_term.api.a_term.run_maintenance_cycle",
        new=AsyncMock(return_value={"reason": "manual", "skipped": False}),
    ) as mock_run:
        response = test_app.post(
            "/api/internal/maintenance/run",
            headers={"Authorization": "Bearer secret"},
        )

    assert response.status_code == 200
    assert response.json()["reason"] == "manual"
    mock_run.assert_awaited_once()


def test_internal_maintenance_runs_come_from_memory(test_app: TestClient) -> None:
    """A real cycle against the fake Tether shows up in the in-memory run history."""
    _app(test_app).state.internal_token = "secret"
    headers = {"Authorization": "Bearer secret"}
    assert test_app.get("/api/internal/maintenance/runs").status_code == 403

    ran = test_app.post("/api/internal/maintenance/run", headers=headers)
    assert ran.status_code == 200, ran.text
    assert ran.json()["skipped"] is False
    assert ran.json()["reconciliation"]["links_dropped"] == 0

    response = test_app.get("/api/internal/maintenance/runs?limit=2", headers=headers)
    assert response.status_code == 200
    items = response.json()["items"]
    assert items[0]["status"] == "success"
    assert items[0]["reason"] == "manual"
    assert response.json()["total"] == len(items)


def test_internal_maintenance_rejects_wrong_token(test_app: TestClient) -> None:
    _app(test_app).state.internal_token = "secret"
    response = test_app.get("/api/internal/maintenance", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 403
