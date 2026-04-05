"""Tests for project settings REST endpoints (/api/aterm/projects)."""

from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient


def test_list_projects_merges_aterm_settings(test_app: TestClient) -> None:
    """GET /api/aterm/projects -- merges SummitFlow projects with local settings."""
    summitflow_projects = [
        {"id": "aterm", "name": "A-Term", "root_path": "/workspace/aterm"},
        {"id": "agent-hub", "name": "Agent Hub", "root_path": "/workspace/agent-hub"},
    ]
    stored_settings = {
        "agent-hub": {
            "project_id": "agent-hub",
            "enabled": True,
            "active_mode": "codex",
            "display_order": 2,
        }
    }

    with (
        patch(
            "aterm.api.projects.summitflow_client.list_projects",
            return_value=summitflow_projects,
        ),
        patch(
            "aterm.api.projects.settings_store.get_all_settings",
            return_value=stored_settings,
        ),
    ):
        response = test_app.get("/api/aterm/projects")

    assert response.status_code == 200
    body = response.json()
    assert [project["id"] for project in body] == ["aterm", "agent-hub"]
    assert body[0]["aterm_enabled"] is False
    assert body[1]["mode"] == "codex"
    assert body[1]["root_path"] == "/workspace/agent-hub"


def test_set_project_mode_returns_full_project_payload(test_app: TestClient) -> None:
    """PUT /api/aterm/projects/{id}/mode -- returns full merged project settings."""
    settings = {
        "project_id": "aterm",
        "enabled": True,
        "active_mode": "codex",
        "display_order": 4,
    }

    with (
        patch(
            "aterm.api.projects.settings_store.set_active_mode",
            return_value=settings,
        ),
        patch(
            "aterm.api.projects.summitflow_client.list_projects",
            return_value=[
                {
                    "id": "aterm",
                    "name": "A-Term",
                    "root_path": "/workspace/aterm",
                }
            ],
        ),
    ):
        response = test_app.put(
            "/api/aterm/projects/aterm/mode",
            json={"mode": "codex"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "id": "aterm",
        "name": "A-Term",
        "root_path": "/workspace/aterm",
        "aterm_enabled": True,
        "mode": "codex",
        "display_order": 4,
    }


def test_set_project_mode_rejects_invalid_mode(test_app: TestClient) -> None:
    """PUT /api/aterm/projects/{id}/mode -- rejects modes with invalid characters."""
    for bad_mode in ["shell; DROP TABLE", "mode with spaces", "<script>", "UPPERCASE"]:
        response = test_app.put(
            "/api/aterm/projects/aterm/mode",
            json={"mode": bad_mode},
        )
        assert response.status_code == 422, f"Expected 422 for mode={bad_mode!r}"


def test_disable_project_returns_disabled_project_payload(test_app: TestClient) -> None:
    """POST /api/aterm/projects/{id}/disable -- disables and returns merged project state."""
    with (
        patch(
            "aterm.api.projects.lifecycle.disable_project_aterm",
            return_value=True,
        ) as mock_disable,
        patch(
            "aterm.api.projects.summitflow_client.list_projects",
            return_value=[
                {
                    "id": "aterm",
                    "name": "A-Term",
                    "root_path": "/workspace/aterm",
                }
            ],
        ),
        patch(
            "aterm.api.projects.settings_store.get_all_settings",
            return_value={
                "aterm": {
                    "project_id": "aterm",
                    "enabled": False,
                    "active_mode": "shell",
                    "display_order": 1,
                }
            },
        ),
    ):
        response = test_app.post("/api/aterm/projects/aterm/disable")

    assert response.status_code == 200
    body = response.json()
    assert body["aterm_enabled"] is False
    assert body["mode"] == "shell"
    mock_disable.assert_called_once_with("aterm")
