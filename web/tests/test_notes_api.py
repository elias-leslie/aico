"""Tests for the A-Term notes API."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

NOTE_FIXTURE = {
    "id": "note-1",
    "project_scope": "a-term",
    "type": "note",
    "title": "Release Notes",
    "content": "Original content",
    "tags": ["alpha"],
    "pinned": False,
    "metadata": {},
    "created_at": None,
    "updated_at": None,
}


def test_notes_capabilities_local_mode(test_app: TestClient) -> None:
    with patch("a_term.api.notes.summitflow_client.has_companion_api", return_value=False):
        response = test_app.get("/api/notes/capabilities")
    assert response.status_code == 200
    assert response.json() == {
        "title_generation": True,
        "formatting": False,
        "prompt_refinement": False,
    }


def test_notes_status_local_mode_reports_standalone(test_app: TestClient) -> None:
    with (
        patch("a_term.api.notes.summitflow_client.has_companion_api", return_value=False),
        patch("a_term.api.notes.project_catalog.get_catalog_source", return_value="local"),
    ):
        response = test_app.get("/api/notes/status")

    assert response.status_code == 200
    assert response.json() == {
        "storage_mode": "standalone",
        "project_catalog_source": "local",
    }


def test_notes_status_companion_mode_reports_shared_backend(test_app: TestClient) -> None:
    with (
        patch("a_term.api.notes.summitflow_client.has_companion_api", return_value=True),
        patch("a_term.api.notes.project_catalog.get_catalog_source", return_value="companion"),
    ):
        response = test_app.get("/api/notes/status")

    assert response.status_code == 200
    assert response.json() == {
        "storage_mode": "companion",
        "project_catalog_source": "companion",
    }


def test_notes_scopes_local_mode_uses_project_registry(test_app: TestClient) -> None:
    with (
        patch("a_term.api.notes.summitflow_client.has_companion_api", return_value=False),
        patch(
            "a_term.api.notes.project_catalog.list_projects",
            new=AsyncMock(
                return_value=[
                    {"id": "a-term", "name": "A-Term"},
                    {"id": "agent-hub", "name": "Agent-Hub"},
                ]
            ),
        ),
        patch(
            "a_term.api.notes.note_store.list_project_scopes",
            return_value=["agent-hub", "legacy-scope"],
        ),
    ):
        response = test_app.get("/api/notes/scopes")

    assert response.status_code == 200
    assert response.json() == [
        {"value": "global", "label": "Global", "known": True},
        {"value": "a-term", "label": "A-Term", "known": True},
        {"value": "agent-hub", "label": "Agent-Hub", "known": True},
        {"value": "legacy-scope", "label": "legacy-scope", "known": False},
    ]


def test_list_notes_local_mode(test_app: TestClient) -> None:
    with (
        patch("a_term.api.notes.summitflow_client.has_companion_api", return_value=False),
        patch("a_term.api.notes.note_store.list_notes", return_value=[NOTE_FIXTURE]),
        patch("a_term.api.notes.note_store.count_notes", return_value=1),
    ):
        response = test_app.get("/api/notes?project_scope=terminal&type=note")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert payload["items"][0]["id"] == "note-1"
    assert payload["items"][0]["project_scope"] == "a-term"


def test_generate_title_local_mode_uses_content_heuristic(test_app: TestClient) -> None:
    with patch("a_term.api.notes.summitflow_client.has_companion_api", return_value=False):
        response = test_app.post(
            "/api/notes/generate-title",
            json={
                "content": "A useful standalone notes title\n\nMore detail follows in the body.",
            },
        )

    assert response.status_code == 200
    assert response.json()["title"] == "A useful standalone notes title"


def test_get_format_proposal_local_mode_returns_null(test_app: TestClient) -> None:
    with (
        patch("a_term.api.notes.summitflow_client.has_companion_api", return_value=False),
        patch("a_term.api.notes.note_store.get_note", return_value=NOTE_FIXTURE),
    ):
        response = test_app.get("/api/notes/note-1/format-proposal")

    assert response.status_code == 200
    assert response.json() is None


def test_format_note_local_mode_reports_unavailable(test_app: TestClient) -> None:
    with patch("a_term.api.notes.summitflow_client.has_companion_api", return_value=False):
        response = test_app.post(
            "/api/notes/format",
            json={"note_id": "note-1", "content": "content", "current_title": "title"},
        )

    assert response.status_code == 501
    assert "unavailable" in response.json()["detail"]


def test_notes_proxy_mode_forwards_upstream_response(test_app: TestClient) -> None:
    upstream = httpx.Response(
        200,
        headers={"content-type": "application/json"},
        content=json.dumps({"items": [], "total": 0}).encode(),
    )
    with (
        patch("a_term.api.notes.summitflow_client.has_companion_api", return_value=True),
        patch(
            "a_term.api.notes.summitflow_client.api_request",
            new=AsyncMock(return_value=upstream),
        ) as mock_request,
    ):
        response = test_app.get("/api/notes?limit=5")

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0}
    mock_request.assert_awaited_once()
    await_args = mock_request.await_args
    assert await_args is not None
    assert await_args.args == ("GET", "/notes")
    assert await_args.kwargs["params"] == [("limit", "5")]
