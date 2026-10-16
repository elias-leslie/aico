"""Agent state and explicit agent restart for Tether sessions."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from .fake_tether import FakeTether


@pytest.mark.parametrize("route", ["agent-state", "claude-state"])
def test_agent_state_from_tether_status(test_app: TestClient, fake_tether: FakeTether, route: str) -> None:
    running = fake_tether.add_session(tool="codex")
    pending = fake_tether.add_session(tool="codex", status="pending")
    shell = fake_tether.add_session(tool="shell")
    states = {
        sid: test_app.get(f"/api/a-term/sessions/{sid}/{route}").json()["agent_state"]
        for sid in (running["id"], pending["id"], shell["id"])
    }
    assert states == {running["id"]: "running", pending["id"]: "starting", shell["id"]: "not_started"}


def test_agent_state_unknown_is_404(test_app: TestClient, fake_tether: FakeTether) -> None:
    assert test_app.get("/api/a-term/sessions/deadbeef/agent-state").status_code == 404


def test_start_agent_running_is_noop(test_app: TestClient, fake_tether: FakeTether) -> None:
    session = fake_tether.add_session(tool="codex")
    body = test_app.post(f"/api/a-term/sessions/{session['id']}/start-agent").json()
    assert body["started"] is False
    assert body["agent_state"] == "running"
    assert not any(path.endswith("/respawn") for _, path, _ in fake_tether.calls)


def test_start_agent_respawns_uncertain(test_app: TestClient, fake_tether: FakeTether) -> None:
    session = fake_tether.add_session(tool="codex", status="uncertain")
    response = test_app.post(f"/api/a-term/sessions/{session['id']}/start-claude")
    assert response.status_code == 200
    assert response.json()["started"] is True
    assert any(path.endswith(f"{session['id']}/respawn") for _, path, _ in fake_tether.calls)


def test_start_agent_refuses_shell(test_app: TestClient, fake_tether: FakeTether) -> None:
    session = fake_tether.add_session(tool="shell", status="uncertain")
    assert test_app.post(f"/api/a-term/sessions/{session['id']}/start-agent").status_code == 400


def test_start_agent_refuses_a_session_an_older_tether_made(test_app: TestClient, fake_tether: FakeTether) -> None:
    session = fake_tether.add_session(tool="codex", status="legacy")
    response = test_app.post(f"/api/a-term/sessions/{session['id']}/start-agent")
    assert response.status_code == 409


def test_start_agent_unknown_is_404(test_app: TestClient, fake_tether: FakeTether) -> None:
    assert test_app.post("/api/a-term/sessions/deadbeef/start-agent").status_code == 404
