"""Tests for the /health endpoint.

Verifies that the health check reports healthy when the database
is reachable and unhealthy when it is not.
"""

from __future__ import annotations

from typing import cast
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _app(client: TestClient) -> FastAPI:
    """Return the underlying FastAPI app from a TestClient."""
    return cast(FastAPI, client.app)


def test_health_healthy_returns_status(test_app: TestClient) -> None:
    """GET /health -- database reachable returns ``{"status": "healthy"}``."""
    # Arrange
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.__enter__ = MagicMock(return_value=mock_conn)
    mock_conn.__exit__ = MagicMock(return_value=False)
    mock_conn.cursor.return_value = mock_cursor
    mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
    mock_cursor.__exit__ = MagicMock(return_value=False)

    with patch("terminal.main.get_connection") as mock_get_conn:
        mock_get_conn.return_value = mock_conn

        # Act
        response = test_app.get("/health")

    # Assert
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "healthy"
    assert body["service"] == "terminal"
    assert "maintenance" in body


def test_health_unhealthy_when_db_down(test_app: TestClient) -> None:
    """GET /health -- database unreachable returns 503 with unhealthy status."""
    # Arrange
    with patch("terminal.main.get_connection", side_effect=RuntimeError("connection refused")):
        # Act
        response = test_app.get("/health")

    # Assert
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "unhealthy"
    assert body["service"] == "terminal"
    assert body["db"] == "down"


def test_health_response_contains_service_field(test_app: TestClient) -> None:
    """GET /health -- response always includes the ``service`` field."""
    # Arrange
    with patch("terminal.main.get_connection", side_effect=Exception("any error")):
        # Act
        response = test_app.get("/health")

    # Assert
    body = response.json()
    assert "service" in body
    assert body["service"] == "terminal"


def test_health_response_includes_maintenance_status(test_app: TestClient) -> None:
    """GET /health -- response includes maintenance observability payload."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.__enter__ = MagicMock(return_value=mock_conn)
    mock_conn.__exit__ = MagicMock(return_value=False)
    mock_conn.cursor.return_value = mock_cursor
    mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
    mock_cursor.__exit__ = MagicMock(return_value=False)
    _app(test_app).state.maintenance_status = {"state": "idle", "runs": 5}

    with patch("terminal.main.get_connection") as mock_get_conn:
        mock_get_conn.return_value = mock_conn
        response = test_app.get("/health")

    assert response.status_code == 200
    assert response.json()["maintenance"]["runs"] == 5
