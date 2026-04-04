"""Tests for session REST endpoints (/api/terminal/sessions).

Covers:
- List sessions
- Get session by ID
- Create session (deprecated, should return 400)
- Update session metadata
- Delete session
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_session(
    session_id: str | None = None,
    name: str = "Test Session",
    is_alive: bool = True,
    mode: str = "shell",
    project_id: str | None = None,
) -> dict[str, Any]:
    """Build a fake session dict matching the shape returned by storage._row_to_dict."""
    sid = session_id or str(uuid.uuid4())
    now = datetime.now(UTC).isoformat()
    return {
        "id": sid,
        "name": name,
        "user_id": None,
        "project_id": project_id,
        "working_dir": "/home/user",
        "display_order": 0,
        "mode": mode,
        "session_number": 1,
        "is_alive": is_alive,
        "created_at": now,
        "last_accessed_at": now,
        "last_claude_session": None,
        "claude_state": "not_started",
        "pane_id": None,
    }


# ---------------------------------------------------------------------------
# List sessions
# ---------------------------------------------------------------------------

def test_list_sessions_returns_items(test_app: TestClient) -> None:
    """GET /api/terminal/sessions -- returns list of alive sessions."""
    # Arrange
    sessions = [_make_session(name="s1"), _make_session(name="s2")]
    external = [
        {
            "id": "claude-summitflow",
            "name": "claude-summitflow",
            "user_id": None,
            "project_id": "summitflow",
            "working_dir": "/home/testuser/summitflow",
            "display_order": 0,
            "mode": "claude",
            "session_number": 0,
            "is_alive": True,
            "created_at": None,
            "last_accessed_at": None,
            "claude_state": "running",
            "tmux_session_name": "claude-summitflow",
            "tmux_pane_id": "%20",
            "is_external": True,
            "source": "tmux_external",
        }
    ]
    with (
        patch("terminal.api.sessions.terminal_store.list_sessions", return_value=sessions),
        patch("terminal.api.sessions.list_external_agent_tmux_sessions", return_value=external),
    ):
        # Act
        response = test_app.get("/api/terminal/sessions")

    # Assert
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 3
    assert len(body["items"]) == 3
    assert body["items"][0]["name"] == "s1"
    assert body["items"][2]["id"] == "claude-summitflow"
    assert body["items"][2]["is_external"] is True


def test_list_sessions_empty_returns_zero_total(test_app: TestClient) -> None:
    """GET /api/terminal/sessions -- empty list returns total=0."""
    # Arrange
    with (
        patch("terminal.api.sessions.terminal_store.list_sessions", return_value=[]),
        patch("terminal.api.sessions.list_external_agent_tmux_sessions", return_value=[]),
    ):
        # Act
        response = test_app.get("/api/terminal/sessions")

    # Assert
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 0
    assert body["items"] == []


# ---------------------------------------------------------------------------
# Get session
# ---------------------------------------------------------------------------

def test_get_session_found_returns_200(test_app: TestClient) -> None:
    """GET /api/terminal/sessions/{id} -- existing session returns 200."""
    # Arrange
    sid = str(uuid.uuid4())
    session = _make_session(session_id=sid, name="My Terminal")
    with patch("terminal.api.sessions.terminal_store.get_session", return_value=session):
        # Act
        response = test_app.get(f"/api/terminal/sessions/{sid}")

    # Assert
    assert response.status_code == 200
    assert response.json()["id"] == sid
    assert response.json()["name"] == "My Terminal"


def test_get_external_session_found_returns_200(test_app: TestClient) -> None:
    """GET /api/terminal/sessions/{id} -- external tmux session returns 200."""
    external = {
        "id": "codex-summitflow",
        "name": "codex-summitflow",
        "user_id": None,
        "project_id": "summitflow",
        "working_dir": "/home/testuser/summitflow",
        "display_order": 0,
        "mode": "codex",
        "session_number": 0,
        "is_alive": True,
        "created_at": None,
        "last_accessed_at": None,
        "claude_state": "running",
        "tmux_session_name": "codex-summitflow",
        "tmux_pane_id": "%21",
        "is_external": True,
        "source": "tmux_external",
    }
    with (
        patch("terminal.api.sessions.terminal_store.get_session", return_value=None),
        patch("terminal.api.sessions.get_external_agent_tmux_session", return_value=external),
    ):
        response = test_app.get("/api/terminal/sessions/codex-summitflow")

    assert response.status_code == 200
    assert response.json()["id"] == "codex-summitflow"
    assert response.json()["tmux_session_name"] == "codex-summitflow"
    assert response.json()["is_external"] is True


def test_get_session_not_found_returns_404(test_app: TestClient) -> None:
    """GET /api/terminal/sessions/{id} -- missing session returns 404."""
    # Arrange
    sid = str(uuid.uuid4())
    with patch("terminal.api.sessions.terminal_store.get_session", return_value=None):
        # Act
        response = test_app.get(f"/api/terminal/sessions/{sid}")

    # Assert
    assert response.status_code == 404


def test_get_session_unknown_external_ref_returns_400(test_app: TestClient) -> None:
    """GET /api/terminal/sessions/{id} -- invalid non-external ref returns 400."""
    with (
        patch("terminal.api.sessions.terminal_store.get_session", return_value=None),
        patch("terminal.api.sessions.get_external_agent_tmux_session", return_value=None),
    ):
        response = test_app.get("/api/terminal/sessions/not-a-uuid")

    # Assert
    assert response.status_code == 400
    assert "Invalid UUID" in response.json()["detail"]


# ---------------------------------------------------------------------------
# Update session
# ---------------------------------------------------------------------------

def test_update_session_name_returns_updated(test_app: TestClient) -> None:
    """PATCH /api/terminal/sessions/{id} -- rename succeeds."""
    # Arrange
    sid = str(uuid.uuid4())
    original = _make_session(session_id=sid, name="Old Name")
    updated = {**original, "name": "New Name"}
    with (
        patch("terminal.api.sessions.terminal_store.get_session", return_value=original),
        patch("terminal.api.sessions.terminal_store.update_session", return_value=updated),
    ):
        # Act
        response = test_app.patch(
            f"/api/terminal/sessions/{sid}",
            json={"name": "New Name"},
        )

    # Assert
    assert response.status_code == 200
    assert response.json()["name"] == "New Name"


def test_update_session_not_found_returns_404(test_app: TestClient) -> None:
    """PATCH /api/terminal/sessions/{id} -- missing session returns 404."""
    # Arrange
    sid = str(uuid.uuid4())
    with patch("terminal.api.sessions.terminal_store.get_session", return_value=None):
        # Act
        response = test_app.patch(
            f"/api/terminal/sessions/{sid}",
            json={"name": "Whatever"},
        )

    # Assert
    assert response.status_code == 404


def test_update_external_session_returns_400(test_app: TestClient) -> None:
    """PATCH /api/terminal/sessions/{id} -- external sessions are read-only."""
    external = {
        "id": "claude-summitflow",
        "name": "claude-summitflow",
        "user_id": None,
        "project_id": "summitflow",
        "working_dir": "/home/testuser/summitflow",
        "display_order": 0,
        "mode": "claude",
        "session_number": 0,
        "is_alive": True,
        "created_at": None,
        "last_accessed_at": None,
        "claude_state": "running",
        "tmux_session_name": "claude-summitflow",
        "tmux_pane_id": "%20",
        "is_external": True,
        "source": "tmux_external",
    }
    with (
        patch("terminal.api.sessions.terminal_store.get_session", return_value=None),
        patch("terminal.api.sessions.get_external_agent_tmux_session", return_value=external),
    ):
        response = test_app.patch(
            "/api/terminal/sessions/claude-summitflow",
            json={"name": "New Name"},
        )

    assert response.status_code == 400
    assert "read-only" in response.json()["detail"]


def test_update_session_no_fields_returns_existing(test_app: TestClient) -> None:
    """PATCH /api/terminal/sessions/{id} -- empty body returns current session."""
    # Arrange
    sid = str(uuid.uuid4())
    existing = _make_session(session_id=sid, name="Unchanged")
    with patch("terminal.api.sessions.terminal_store.get_session", return_value=existing):
        # Act
        response = test_app.patch(
            f"/api/terminal/sessions/{sid}",
            json={},
        )

    # Assert
    assert response.status_code == 200
    assert response.json()["name"] == "Unchanged"


# ---------------------------------------------------------------------------
# Delete session
# ---------------------------------------------------------------------------

def test_delete_session_success_returns_deleted(test_app: TestClient) -> None:
    """DELETE /api/terminal/sessions/{id} -- returns deleted=True."""
    sid = str(uuid.uuid4())
    result = {
        "deleted": True,
        "id": sid,
        "next_session_id": None,
        "pane_id": None,
        "pane_deleted": False,
        "is_external": False,
    }
    with patch("terminal.api.sessions.close_session", return_value=result) as close_mock:
        response = test_app.delete(f"/api/terminal/sessions/{sid}")

    assert response.status_code == 200
    body = response.json()
    assert body["deleted"] is True
    assert body["id"] == sid
    assert body["next_session_id"] is None
    close_mock.assert_called_once_with(sid)


def test_delete_session_invalid_uuid_returns_400(test_app: TestClient) -> None:
    """DELETE /api/terminal/sessions/{id} -- malformed UUID returns 400."""
    # Act
    response = test_app.delete("/api/terminal/sessions/bad-id")

    # Assert
    assert response.status_code == 400


def test_delete_external_session_returns_deleted(test_app: TestClient) -> None:
    """DELETE /api/terminal/sessions/{id} -- external tmux sessions can be closed."""
    session_id = "codex-summitflow"
    result = {
        "deleted": True,
        "id": session_id,
        "next_session_id": None,
        "pane_id": None,
        "pane_deleted": False,
        "is_external": True,
    }
    with (
        patch(
            "terminal.api.sessions.get_external_agent_tmux_session",
            return_value={"id": session_id, "tmux_session_name": session_id},
        ),
        patch("terminal.api.sessions.close_session", return_value=result) as close_mock,
    ):
        response = test_app.delete(f"/api/terminal/sessions/{session_id}")

    assert response.status_code == 200
    assert response.json()["is_external"] is True
    close_mock.assert_called_once_with(session_id)


def test_delete_session_returns_next_session_id_for_visible_pane_transition(test_app: TestClient) -> None:
    """DELETE /api/terminal/sessions/{id} -- returns pane transition details."""
    sid = str(uuid.uuid4())
    next_sid = str(uuid.uuid4())
    pane_id = str(uuid.uuid4())
    result = {
        "deleted": True,
        "id": sid,
        "next_session_id": next_sid,
        "pane_id": pane_id,
        "pane_deleted": False,
        "is_external": False,
    }
    with patch("terminal.api.sessions.close_session", return_value=result):
        response = test_app.delete(f"/api/terminal/sessions/{sid}")

    assert response.status_code == 200
    assert response.json()["next_session_id"] == next_sid
    assert response.json()["pane_id"] == pane_id
    assert response.json()["pane_deleted"] is False
