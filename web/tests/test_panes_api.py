"""Tests for pane REST endpoints (/api/a-term/panes).

Covers:
- List panes
- Create pane (with pane limit enforcement)
- Get pane by ID
- Delete pane
- Pane count endpoint
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

def _make_pane(
    pane_id: str | None = None,
    pane_type: str = "adhoc",
    project_id: str | None = None,
    pane_name: str = "Test Pane",
    pane_order: int = 0,
    active_mode: str = "shell",
    is_detached: bool = False,
    sessions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a fake pane dict matching storage shape."""
    pid = pane_id or str(uuid.uuid4())
    return {
        "id": pid,
        "pane_type": pane_type,
        "project_id": project_id,
        "pane_order": pane_order,
        "pane_name": pane_name,
        "active_mode": active_mode,
        "is_detached": is_detached,
        "created_at": datetime.now(UTC),
        "sessions": sessions or [],
        "width_percent": 100.0,
        "height_percent": 100.0,
        "grid_row": 0,
        "grid_col": 0,
    }


def _make_session_in_pane(
    session_id: str | None = None,
    mode: str = "shell",
    name: str = "Shell",
) -> dict[str, Any]:
    """Build a fake session dict inside a pane."""
    return {
        "id": session_id or str(uuid.uuid4()),
        "name": name,
        "mode": mode,
        "session_number": 1,
        "is_alive": True,
        "working_dir": "/home/user",
        "claude_state": "not_started",
    }


# ---------------------------------------------------------------------------
# List panes
# ---------------------------------------------------------------------------

def test_list_panes_returns_items(test_app: TestClient) -> None:
    """GET /api/a-term/panes -- returns pane list with total and max."""
    # Arrange
    panes = [_make_pane(pane_name="p1"), _make_pane(pane_name="p2")]
    with patch("a_term.api.panes.pane_store.list_panes_with_sessions", return_value=panes):
        # Act
        response = test_app.get("/api/a-term/panes")

    # Assert
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert body["max_panes"] == 6
    assert len(body["items"]) == 2


def test_list_panes_empty_returns_zero(test_app: TestClient) -> None:
    """GET /api/a-term/panes -- empty list returns total=0."""
    # Arrange
    with patch("a_term.api.panes.pane_store.list_panes_with_sessions", return_value=[]):
        # Act
        response = test_app.get("/api/a-term/panes")

    # Assert
    body = response.json()
    assert body["total"] == 0
    assert body["items"] == []


def test_list_detached_panes_returns_items(test_app: TestClient) -> None:
    """GET /api/a-term/panes/detached -- returns detached pane list."""
    panes = [_make_pane(pane_name="Detached", is_detached=True)]
    with patch("a_term.api.panes.pane_store.list_panes_with_sessions", return_value=panes):
        response = test_app.get("/api/a-term/panes/detached")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["items"][0]["pane_name"] == "Detached"
    assert body["items"][0]["is_detached"] is True


# ---------------------------------------------------------------------------
# Create pane
# ---------------------------------------------------------------------------

def test_create_pane_adhoc_returns_pane(test_app: TestClient) -> None:
    """POST /api/a-term/panes -- adhoc pane creation succeeds."""
    # Arrange
    shell_session = _make_session_in_pane(mode="shell")
    pane = _make_pane(pane_type="adhoc", pane_name="Ad-hoc", sessions=[shell_session])
    with (
        patch("a_term.api.panes.pane_store.count_panes", return_value=0),
        patch("a_term.api.panes.pane_store.create_pane_with_sessions", return_value=pane),
    ):
        # Act
        response = test_app.post(
            "/api/a-term/panes",
            json={"pane_type": "adhoc", "pane_name": "Ad-hoc"},
        )

    # Assert
    assert response.status_code == 200
    body = response.json()
    assert body["pane_type"] == "adhoc"
    assert body["pane_name"] == "Ad-hoc"
    assert len(body["sessions"]) == 1
    assert body["sessions"][0]["agent_state"] == "not_started"


def test_create_pane_limit_exceeded_returns_400(test_app: TestClient) -> None:
    """POST /api/a-term/panes -- 6 panes already exist rejects creation."""
    # Arrange
    with patch(
        "a_term.api.panes.pane_store.create_pane_with_sessions",
        side_effect=ValueError("Maximum 6 panes allowed. Close one to add more."),
    ):
        # Act
        response = test_app.post(
            "/api/a-term/panes",
            json={"pane_type": "adhoc", "pane_name": "Seventh"},
        )

    # Assert
    assert response.status_code == 400
    assert "Maximum" in response.json()["detail"]


def test_create_pane_project_without_project_id_returns_400(test_app: TestClient) -> None:
    """POST /api/a-term/panes -- project pane without project_id returns 400."""
    # Arrange
    with patch("a_term.api.panes.pane_store.count_panes", return_value=0):
        # Act
        response = test_app.post(
            "/api/a-term/panes",
            json={"pane_type": "project", "pane_name": "Project Pane"},
        )

    # Assert
    assert response.status_code == 400
    assert "project_id" in response.json()["detail"].lower()


def test_create_project_pane_passes_requested_agent_tool_slug(test_app: TestClient) -> None:
    """POST /api/a-term/panes -- project pane forwards agent_tool_slug to storage."""
    pane = _make_pane(
        pane_type="project",
        project_id="proj-1",
        pane_name="Project Pane",
        active_mode="codex",
        sessions=[
            _make_session_in_pane(mode="shell", name="Shell"),
            _make_session_in_pane(mode="codex", name="Codex"),
        ],
    )
    with (
        patch(
            "a_term.api.panes.agent_tools_store.get_by_slug",
            return_value={"slug": "codex", "name": "Codex", "enabled": True},
        ),
        patch(
            "a_term.api.panes.pane_store.create_pane_with_sessions",
            return_value=pane,
        ) as create_mock,
    ):
        response = test_app.post(
            "/api/a-term/panes",
            json={
                "pane_type": "project",
                "pane_name": "Project Pane",
                "project_id": "proj-1",
                "working_dir": "/workspace/proj-1",
                "agent_tool_slug": "codex",
            },
        )

    assert response.status_code == 200
    create_mock.assert_called_once_with(
        pane_type="project",
        pane_name="Project Pane",
        project_id="proj-1",
        working_dir="/workspace/proj-1",
        agent_tool_slug="codex",
    )


def test_create_project_pane_persists_resolved_active_mode(test_app: TestClient) -> None:
    """POST /api/a-term/panes -- project panes persist the created active mode."""
    pane = _make_pane(
        pane_type="project",
        project_id="proj-1",
        pane_name="Project Pane",
        active_mode="codex",
        sessions=[
            _make_session_in_pane(mode="shell", name="Shell"),
            _make_session_in_pane(mode="codex", name="Codex"),
        ],
    )
    with (
        patch("a_term.api.panes.pane_store.create_pane_with_sessions", return_value=pane),
        patch("a_term.api.panes.project_settings_store.upsert_settings") as upsert_mock,
    ):
        response = test_app.post(
            "/api/a-term/panes",
            json={
                "pane_type": "project",
                "pane_name": "Project Pane",
                "project_id": "proj-1",
                "working_dir": "/workspace/proj-1",
            },
        )

    assert response.status_code == 200
    upsert_mock.assert_called_once_with(
        "proj-1",
        enabled=True,
        active_mode="codex",
    )


def test_create_pane_forwards_detached_layout_fields_when_present(test_app: TestClient) -> None:
    """POST /api/a-term/panes -- forwards detached/layout fields only when requested."""
    pane = _make_pane(
        pane_type="adhoc",
        pane_name="Detached Pane",
        is_detached=True,
        pane_order=3,
    )
    with patch(
        "a_term.api.panes.pane_store.create_pane_with_sessions",
        return_value=pane,
    ) as create_mock:
        response = test_app.post(
            "/api/a-term/panes",
            json={
                "pane_type": "adhoc",
                "pane_name": "Detached Pane",
                "detached": True,
                "pane_order": 3,
                "width_percent": 55.0,
                "height_percent": 45.0,
                "grid_row": 1,
                "grid_col": 2,
            },
        )

    assert response.status_code == 200
    create_mock.assert_called_once_with(
        pane_type="adhoc",
        pane_name="Detached Pane",
        project_id=None,
        working_dir=None,
        agent_tool_slug=None,
        is_detached=True,
        pane_order=3,
        width_percent=55.0,
        height_percent=45.0,
        grid_row=1,
        grid_col=2,
    )


# ---------------------------------------------------------------------------
# Get pane
# ---------------------------------------------------------------------------

def test_get_pane_found_returns_200(test_app: TestClient) -> None:
    """GET /api/a-term/panes/{id} -- existing pane returns 200."""
    # Arrange
    pid = str(uuid.uuid4())
    pane = _make_pane(pane_id=pid, pane_name="Found Pane")
    with patch("a_term.api.panes.pane_store.get_pane_with_sessions", return_value=pane):
        # Act
        response = test_app.get(f"/api/a-term/panes/{pid}")

    # Assert
    assert response.status_code == 200
    assert response.json()["id"] == pid


def test_get_pane_not_found_returns_404(test_app: TestClient) -> None:
    """GET /api/a-term/panes/{id} -- missing pane returns 404."""
    # Arrange
    pid = str(uuid.uuid4())
    with patch("a_term.api.panes.pane_store.get_pane_with_sessions", return_value=None):
        # Act
        response = test_app.get(f"/api/a-term/panes/{pid}")

    # Assert
    assert response.status_code == 404


def test_get_pane_invalid_uuid_returns_400(test_app: TestClient) -> None:
    """GET /api/a-term/panes/{id} -- malformed UUID returns 400."""
    # Act
    response = test_app.get("/api/a-term/panes/not-valid")

    # Assert
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# Update pane
# ---------------------------------------------------------------------------

def test_update_project_pane_rejects_unavailable_mode(test_app: TestClient) -> None:
    """PATCH /api/a-term/panes/{id} -- rejects mode not present in pane sessions."""
    # Arrange
    pid = str(uuid.uuid4())
    pane = _make_pane(
        pane_id=pid,
        pane_type="project",
        project_id="proj-1",
        active_mode="shell",
        sessions=[
            _make_session_in_pane(mode="shell", name="Shell"),
            _make_session_in_pane(mode="claude", name="Claude"),
        ],
    )
    with patch("a_term.api.panes.pane_store.get_pane_with_sessions", return_value=pane):
        # Act
        response = test_app.patch(
            f"/api/a-term/panes/{pid}",
            json={"active_mode": "codex"},
        )

    # Assert
    assert response.status_code == 400
    assert "not available" in response.json()["detail"]


def test_update_project_pane_accepts_existing_mode(test_app: TestClient) -> None:
    """PATCH /api/a-term/panes/{id} -- allows switching to an existing session mode."""
    # Arrange
    pid = str(uuid.uuid4())
    pane = _make_pane(
        pane_id=pid,
        pane_type="project",
        project_id="proj-1",
        active_mode="shell",
        sessions=[
            _make_session_in_pane(mode="shell", name="Shell"),
            _make_session_in_pane(mode="claude", name="Claude"),
        ],
    )
    updated = {**pane, "active_mode": "claude"}
    with (
        patch("a_term.api.panes.pane_store.get_pane_with_sessions", side_effect=[pane, updated]),
        patch("a_term.api.panes.pane_store.update_pane", return_value=updated),
    ):
        # Act
        response = test_app.patch(
            f"/api/a-term/panes/{pid}",
            json={"active_mode": "claude"},
        )

    # Assert
    assert response.status_code == 200
    assert response.json()["active_mode"] == "claude"


def test_update_project_pane_recovers_missing_shell_session_when_switching_to_shell(test_app: TestClient) -> None:
    """PATCH /api/a-term/panes/{id} -- recreates a missing shell session before switching."""
    pid = str(uuid.uuid4())
    existing = _make_pane(
        pane_id=pid,
        pane_type="project",
        project_id="proj-1",
        active_mode="hermes",
        sessions=[
            {
                **_make_session_in_pane(mode="hermes", name="Project: proj-1"),
                "working_dir": "/workspace/proj-1",
            },
        ],
    )
    healed = {
        **existing,
        "sessions": [
            {
                **_make_session_in_pane(
                    session_id="shell-session",
                    mode="shell",
                    name="Project: proj-1",
                ),
                "working_dir": "/workspace/proj-1",
            },
            {
                **_make_session_in_pane(mode="hermes", name="Project: proj-1"),
                "working_dir": "/workspace/proj-1",
            },
        ],
    }
    switched = {**healed, "active_mode": "shell"}
    with (
        patch(
            "a_term.api.panes.pane_store.get_pane_with_sessions",
            side_effect=[existing, healed, switched],
        ),
        patch("a_term.api.panes.create_session", return_value="shell-session") as create_mock,
        patch("a_term.api.panes.pane_store.update_pane", return_value=switched) as update_mock,
    ):
        response = test_app.patch(
            f"/api/a-term/panes/{pid}",
            json={"active_mode": "shell"},
        )

    assert response.status_code == 200
    assert response.json()["active_mode"] == "shell"
    create_mock.assert_called_once_with(
        name="Project: proj-1",
        project_id="proj-1",
        working_dir="/workspace/proj-1",
        mode="shell",
        pane_id=pid,
    )
    update_mock.assert_called_once_with(pid, active_mode="shell")


# ---------------------------------------------------------------------------
# Swap panes
# ---------------------------------------------------------------------------


def test_swap_panes_uses_static_route_before_pane_id(test_app: TestClient) -> None:
    """POST /api/a-term/panes/swap -- resolves the static route instead of {pane_id}."""
    pane_id_a = str(uuid.uuid4())
    pane_id_b = str(uuid.uuid4())
    with patch("a_term.api.panes.pane_store.swap_pane_positions", return_value=True) as swap_mock:
        response = test_app.post(
            "/api/a-term/panes/swap",
            json={"pane_id_a": pane_id_a, "pane_id_b": pane_id_b},
        )

    assert response.status_code == 200
    assert response.json() == {
        "swapped": True,
        "pane_id_a": pane_id_a,
        "pane_id_b": pane_id_b,
    }
    swap_mock.assert_called_once_with(pane_id_a, pane_id_b)


# ---------------------------------------------------------------------------
# Delete pane
# ---------------------------------------------------------------------------

def test_delete_pane_success_returns_deleted(test_app: TestClient) -> None:
    """DELETE /api/a-term/panes/{id} -- successful deletion."""
    # Arrange
    pid = str(uuid.uuid4())
    with (
        patch("a_term.api.panes.pane_store.fetch_sessions_for_pane", return_value=[]),
        patch("a_term.api.panes.kill_tmux_session"),
        patch("a_term.api.panes.pane_store.delete_pane", return_value=True),
    ):
        # Act
        response = test_app.delete(f"/api/a-term/panes/{pid}")

    # Assert
    assert response.status_code == 200
    body = response.json()
    assert body["deleted"] is True
    assert body["id"] == pid


def test_delete_pane_not_found_returns_404(test_app: TestClient) -> None:
    """DELETE /api/a-term/panes/{id} -- pane not in DB returns 404."""
    # Arrange
    pid = str(uuid.uuid4())
    with (
        patch("a_term.api.panes.pane_store.fetch_sessions_for_pane", return_value=[]),
        patch("a_term.api.panes.pane_store.delete_pane", return_value=False),
    ):
        # Act
        response = test_app.delete(f"/api/a-term/panes/{pid}")

    # Assert
    assert response.status_code == 404


def test_detach_pane_success_returns_updated_pane(test_app: TestClient) -> None:
    """POST /api/a-term/panes/{id}/detach -- marks the pane detached."""
    pid = str(uuid.uuid4())
    existing = _make_pane(pane_id=pid, pane_name="Detached Pane", is_detached=False)
    detached = _make_pane(pane_id=pid, pane_name="Detached Pane", is_detached=True)
    with (
        patch("a_term.api.panes.pane_store.get_pane_with_sessions", return_value=existing),
        patch("a_term.api.panes.pane_store.detach_pane", return_value=detached) as detach_mock,
    ):
        response = test_app.post(f"/api/a-term/panes/{pid}/detach")

    assert response.status_code == 200
    assert response.json()["id"] == pid
    assert response.json()["is_detached"] is True
    detach_mock.assert_called_once_with(pid)


def test_attach_pane_success_returns_updated_pane(test_app: TestClient) -> None:
    """POST /api/a-term/panes/{id}/attach -- restores a detached pane."""
    pid = str(uuid.uuid4())
    existing = _make_pane(pane_id=pid, pane_name="Attached Pane", is_detached=True)
    attached = _make_pane(pane_id=pid, pane_name="Attached Pane", is_detached=False)
    with (
        patch("a_term.api.panes.pane_store.get_pane_with_sessions", return_value=existing),
        patch("a_term.api.panes.pane_store.attach_pane", return_value=attached) as attach_mock,
    ):
        response = test_app.post(f"/api/a-term/panes/{pid}/attach")

    assert response.status_code == 200
    assert response.json()["id"] == pid
    assert response.json()["is_detached"] is False
    attach_mock.assert_called_once_with(pid)


def test_attach_pane_forwards_requested_layout_fields(test_app: TestClient) -> None:
    """POST /api/a-term/panes/{id}/attach -- forwards placement fields when supplied."""
    pid = str(uuid.uuid4())
    existing = _make_pane(pane_id=pid, pane_name="Attach Layout", is_detached=True)
    attached = _make_pane(pane_id=pid, pane_name="Attach Layout", is_detached=False)
    with (
        patch("a_term.api.panes.pane_store.get_pane_with_sessions", return_value=existing),
        patch("a_term.api.panes.pane_store.attach_pane", return_value=attached) as attach_mock,
    ):
        response = test_app.post(
            f"/api/a-term/panes/{pid}/attach",
            json={
                "pane_order": 4,
                "width_percent": 60.0,
                "height_percent": 40.0,
                "grid_row": 1,
                "grid_col": 0,
            },
        )

    assert response.status_code == 200
    attach_mock.assert_called_once_with(
        pid,
        pane_order=4,
        width_percent=60.0,
        height_percent=40.0,
        grid_row=1,
        grid_col=0,
    )


# ---------------------------------------------------------------------------
# Pane count
# ---------------------------------------------------------------------------

def test_pane_count_returns_count_and_limit(test_app: TestClient) -> None:
    """GET /api/a-term/panes/count -- returns count, max, at_limit."""
    # Arrange
    with patch("a_term.api.panes.pane_store.count_panes", return_value=3):
        # Act
        response = test_app.get("/api/a-term/panes/count")

    # Assert
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 3
    assert body["max_panes"] == 6
    assert body["at_limit"] is False


def test_pane_count_at_limit_returns_true(test_app: TestClient) -> None:
    """GET /api/a-term/panes/count -- at_limit is True when count >= max."""
    # Arrange
    with patch("a_term.api.panes.pane_store.count_panes", return_value=6):
        # Act
        response = test_app.get("/api/a-term/panes/count")

    # Assert
    body = response.json()
    assert body["at_limit"] is True
