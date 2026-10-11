"""/health: healthy when Tether answers with a compatible API; tmux is reported."""

from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from .fake_tether import FakeTether


@pytest.fixture(autouse=True)
def health_tmux() -> Iterator[MagicMock]:
    """main.py holds its own reference to run_tmux_command."""
    with patch("a_term.main.run_tmux_command", return_value=(False, "no server running")) as run:
        yield run


def test_health_ok_with_tether(test_app: TestClient, fake_tether: FakeTether) -> None:
    response = test_app.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "healthy"
    assert body["tether"]["status"] == "ok"
    assert body["tether"]["apiVersion"] == 1
    assert body["tmux"] == "no_sessions"
    assert "maintenance" in body


def test_health_reports_tmux_ok(test_app: TestClient, health_tmux: MagicMock) -> None:
    health_tmux.return_value = (True, "main: 1 windows")
    assert test_app.get("/health").json()["tmux"] == "ok"


def test_health_unhealthy_when_tether_down(test_app: TestClient, fake_tether: FakeTether) -> None:
    fake_tether.stop()
    response = test_app.get("/health")
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "unhealthy"
    assert body["tether"]["status"] == "down"


def test_health_unhealthy_when_tether_too_old(test_app: TestClient, fake_tether: FakeTether) -> None:
    fake_tether.state.api_version = 0
    response = test_app.get("/health")
    assert response.status_code == 503
    assert response.json()["tether"]["status"] == "incompatible"


def test_health_needs_no_auth(test_app: TestClient) -> None:
    assert "detail" not in test_app.get("/health").json()
