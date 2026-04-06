"""Tests for project settings REST endpoints (/api/a-term/projects)."""

from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient


def test_list_projects_merges_a_term_settings(test_app: TestClient) -> None:
    """GET /api/a-term/projects -- merges SummitFlow projects with local settings."""
    summitflow_projects = [
        {"id": "a-term", "name": "A-Term", "root_path": "/workspace/a-term"},
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
            "a_term.api.projects.summitflow_client.list_projects",
            return_value=summitflow_projects,
        ),
        patch(
            "a_term.api.projects.settings_store.get_all_settings",
            return_value=stored_settings,
        ),
    ):
        response = test_app.get("/api/a-term/projects")

    assert response.status_code == 200
    body = response.json()
    assert [project["id"] for project in body] == ["a-term", "agent-hub"]
    assert body[0]["a_term_enabled"] is False
    assert body[1]["mode"] == "codex"
    assert body[1]["root_path"] == "/workspace/agent-hub"


def test_set_project_mode_returns_full_project_payload(test_app: TestClient) -> None:
    """PUT /api/a-term/projects/{id}/mode -- returns full merged project settings."""
    settings = {
        "project_id": "a-term",
        "enabled": True,
        "active_mode": "codex",
        "display_order": 4,
    }

    with (
        patch(
            "a_term.api.projects.settings_store.set_active_mode",
            return_value=settings,
        ),
        patch(
            "a_term.api.projects.summitflow_client.list_projects",
            return_value=[
                {
                    "id": "a-term",
                    "name": "A-Term",
                    "root_path": "/workspace/a-term",
                }
            ],
        ),
    ):
        response = test_app.put(
            "/api/a-term/projects/a-term/mode",
            json={"mode": "codex"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "id": "a-term",
        "name": "A-Term",
        "root_path": "/workspace/a-term",
        "a_term_enabled": True,
        "mode": "codex",
        "display_order": 4,
    }


def test_set_project_mode_rejects_invalid_mode(test_app: TestClient) -> None:
    """PUT /api/a-term/projects/{id}/mode -- rejects modes with invalid characters."""
    for bad_mode in ["shell; DROP TABLE", "mode with spaces", "<script>", "UPPERCASE"]:
        response = test_app.put(
            "/api/a-term/projects/a-term/mode",
            json={"mode": bad_mode},
        )
        assert response.status_code == 422, f"Expected 422 for mode={bad_mode!r}"


def test_disable_project_returns_disabled_project_payload(test_app: TestClient) -> None:
    """POST /api/a-term/projects/{id}/disable -- disables and returns merged project state."""
    with (
        patch(
            "a_term.api.projects.lifecycle.disable_project_a_term",
            return_value=True,
        ) as mock_disable,
        patch(
            "a_term.api.projects.summitflow_client.list_projects",
            return_value=[
                {
                    "id": "a-term",
                    "name": "A-Term",
                    "root_path": "/workspace/a-term",
                }
            ],
        ),
        patch(
            "a_term.api.projects.settings_store.get_all_settings",
            return_value={
                "a-term": {
                    "project_id": "a-term",
                    "enabled": False,
                    "active_mode": "shell",
                    "display_order": 1,
                }
            },
        ),
    ):
        response = test_app.post("/api/a-term/projects/a-term/disable")

    assert response.status_code == 200
    body = response.json()
    assert body["a_term_enabled"] is False
    assert body["mode"] == "shell"
    mock_disable.assert_called_once_with("a-term")
