"""Tests for agent state/start endpoints with external tmux sessions."""

from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient


def test_get_agent_state_returns_external_tmux_state(test_app: TestClient) -> None:
    external = {
        "id": "claude-summitflow",
        "mode": "claude",
        "claude_state": "running",
    }
    with (
        patch("a_term.api.agent.a_term_store.get_session", return_value=None),
        patch("a_term.api.agent.get_external_agent_tmux_session", return_value=external),
    ):
        response = test_app.get("/api/a-term/sessions/claude-summitflow/agent-state")

    assert response.status_code == 200
    assert response.json() == {
        "session_id": "claude-summitflow",
        "claude_state": "running",
    }


def test_get_agent_state_session_not_found(test_app: TestClient) -> None:
    with (
        patch("a_term.api.agent.get_external_agent_tmux_session", return_value=None),
        patch("a_term.api.agent.a_term_store.get_session", return_value=None),
    ):
        response = test_app.get("/api/a-term/sessions/nonexistent/agent-state")

    assert response.status_code == 404
    assert "not found" in response.json()["detail"]


def test_get_agent_state_normalizes_unknown_state(test_app: TestClient) -> None:
    session = {"id": "s1", "claude_state": "bogus_state"}
    with (
        patch("a_term.api.agent.get_external_agent_tmux_session", return_value=None),
        patch("a_term.api.agent.a_term_store.get_session", return_value=session),
    ):
        response = test_app.get("/api/a-term/sessions/s1/agent-state")

    assert response.status_code == 200
    assert response.json()["claude_state"] == "not_started"


def test_legacy_claude_state_alias(test_app: TestClient) -> None:
    session = {"id": "s1", "claude_state": "running"}
    with (
        patch("a_term.api.agent.get_external_agent_tmux_session", return_value=None),
        patch("a_term.api.agent.a_term_store.get_session", return_value=session),
    ):
        response = test_app.get("/api/a-term/sessions/s1/claude-state")

    assert response.status_code == 200
    assert response.json()["claude_state"] == "running"


def test_start_agent_returns_noop_for_external_tmux_session(test_app: TestClient) -> None:
    external = {
        "id": "codex-summitflow",
        "mode": "codex",
        "claude_state": "running",
    }
    with (
        patch("a_term.api.agent.a_term_store.get_session", return_value=None),
        patch("a_term.api.agent.get_external_agent_tmux_session", return_value=external),
    ):
        response = test_app.post("/api/a-term/sessions/codex-summitflow/start-agent")

    assert response.status_code == 200
    assert response.json() == {
        "session_id": "codex-summitflow",
        "started": False,
        "message": "External tmux agent session is already running",
        "claude_state": "running",
    }


def test_start_agent_ensures_tmux_session_before_launch(test_app: TestClient) -> None:
    session = {
        "id": "session-1",
        "mode": "claude",
        "claude_state": "not_started",
    }
    tool = {"command": "claude", "process_name": "claude"}
    with (
        patch("a_term.api.agent.get_external_agent_tmux_session", return_value=None),
        patch("a_term.api.agent.a_term_store.get_session", return_value=session),
        patch("a_term.api.agent.agent_tools_store.get_by_slug", return_value=tool),
        patch("a_term.api.agent.lifecycle.ensure_session_alive", return_value=True) as ensure_mock,
        patch("a_term.api.agent.is_agent_running", return_value=False),
        patch("a_term.api.agent.atomically_set_starting", return_value=None),
        patch("a_term.api.agent.send_agent_command", return_value=None) as send_mock,
        patch("a_term.api.agent.background_verify_agent_start"),
    ):
        response = test_app.post("/api/a-term/sessions/session-1/start-agent")

    assert response.status_code == 200
    ensure_mock.assert_called_once_with("session-1")
    send_mock.assert_called_once_with("session-1", "summitflow-session-1", "claude")
