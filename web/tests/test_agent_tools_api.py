"""Tests for agent tools CRUD API endpoints."""

from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

TOOL_FIXTURE = {
    "id": "tool-1",
    "name": "Claude",
    "slug": "claude",
    "command": "claude",
    "process_name": "claude",
    "description": "Claude CLI",
    "color": "#7c3aed",
    "display_order": 0,
    "is_default": True,
    "enabled": True,
    "created_at": "2026-01-01T00:00:00",
    "updated_at": "2026-01-01T00:00:00",
}


def test_list_agent_tools(test_app: TestClient) -> None:
    with patch("a_term.api.agent_tools.agent_tools_store.list_all", return_value=[TOOL_FIXTURE]):
        response = test_app.get("/api/a-term/agent-tools")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["slug"] == "claude"


def test_list_agent_tools_enabled_only(test_app: TestClient) -> None:
    with patch("a_term.api.agent_tools.agent_tools_store.list_enabled", return_value=[TOOL_FIXTURE]):
        response = test_app.get("/api/a-term/agent-tools?enabled_only=true")
    assert response.status_code == 200
    assert len(response.json()) == 1


def test_create_agent_tool(test_app: TestClient) -> None:
    with (
        patch("a_term.api.agent_tools.agent_tools_store.get_by_slug", return_value=None),
        patch("a_term.api.agent_tools.agent_tools_store.create", return_value=TOOL_FIXTURE),
    ):
        response = test_app.post(
            "/api/a-term/agent-tools",
            json={
                "name": "Claude",
                "slug": "claude",
                "command": "claude",
                "process_name": "claude",
            },
        )
    assert response.status_code == 201
    assert response.json()["slug"] == "claude"


def test_create_agent_tool_duplicate_slug(test_app: TestClient) -> None:
    with patch("a_term.api.agent_tools.agent_tools_store.get_by_slug", return_value=TOOL_FIXTURE):
        response = test_app.post(
            "/api/a-term/agent-tools",
            json={
                "name": "Claude",
                "slug": "claude",
                "command": "claude",
                "process_name": "claude",
            },
        )
    assert response.status_code == 409
    assert "already exists" in response.json()["detail"]


def test_create_agent_tool_invalid_slug(test_app: TestClient) -> None:
    response = test_app.post(
        "/api/a-term/agent-tools",
        json={
            "name": "Claude",
            "slug": "INVALID SLUG!",
            "command": "claude",
            "process_name": "claude",
        },
    )
    assert response.status_code == 422  # Pydantic validation


def test_create_agent_tool_internal_error_hides_exception_text(test_app: TestClient) -> None:
    with (
        patch("a_term.api.agent_tools.agent_tools_store.get_by_slug", return_value=None),
        patch("a_term.api.agent_tools.agent_tools_store.create", side_effect=RuntimeError("boom: secret path")),
    ):
        response = test_app.post(
            "/api/a-term/agent-tools",
            json={
                "name": "Claude",
                "slug": "claude",
                "command": "claude",
                "process_name": "claude",
            },
        )
    assert response.status_code == 500
    assert response.json()["detail"] == "Failed to create agent tool"


def test_update_agent_tool(test_app: TestClient) -> None:
    updated = {**TOOL_FIXTURE, "name": "Claude v2"}
    with (
        patch("a_term.api.agent_tools.agent_tools_store.get_by_id", return_value=TOOL_FIXTURE),
        patch("a_term.api.agent_tools.agent_tools_store.update", return_value=updated),
    ):
        response = test_app.patch(
            "/api/a-term/agent-tools/tool-1",
            json={"name": "Claude v2"},
        )
    assert response.status_code == 200
    assert response.json()["name"] == "Claude v2"


def test_update_agent_tool_not_found(test_app: TestClient) -> None:
    with patch("a_term.api.agent_tools.agent_tools_store.get_by_id", return_value=None):
        response = test_app.patch(
            "/api/a-term/agent-tools/missing",
            json={"name": "New Name"},
        )
    assert response.status_code == 404


def test_update_agent_tool_empty_body(test_app: TestClient) -> None:
    with patch("a_term.api.agent_tools.agent_tools_store.get_by_id", return_value=TOOL_FIXTURE):
        response = test_app.patch(
            "/api/a-term/agent-tools/tool-1",
            json={},
        )
    assert response.status_code == 200
    assert response.json()["name"] == "Claude"  # unchanged


def test_delete_agent_tool(test_app: TestClient) -> None:
    with (
        patch("a_term.api.agent_tools.agent_tools_store.get_by_id", return_value=TOOL_FIXTURE),
        patch("a_term.api.agent_tools.agent_tools_store.has_active_sessions", return_value=False),
        patch("a_term.api.agent_tools.agent_tools_store.delete", return_value=True),
    ):
        response = test_app.delete("/api/a-term/agent-tools/tool-1")
    assert response.status_code == 200
    assert response.json()["deleted"] is True


def test_delete_agent_tool_with_active_sessions(test_app: TestClient) -> None:
    with (
        patch("a_term.api.agent_tools.agent_tools_store.get_by_id", return_value=TOOL_FIXTURE),
        patch("a_term.api.agent_tools.agent_tools_store.has_active_sessions", return_value=True),
    ):
        response = test_app.delete("/api/a-term/agent-tools/tool-1")
    assert response.status_code == 409
    assert "active sessions" in response.json()["detail"]


def test_delete_agent_tool_not_found(test_app: TestClient) -> None:
    with patch("a_term.api.agent_tools.agent_tools_store.get_by_id", return_value=None):
        response = test_app.delete("/api/a-term/agent-tools/missing")
    assert response.status_code == 404
