"""Tests for pane-scoped file browser endpoints."""

from __future__ import annotations

import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient


def _pane_with_sessions(
    *,
    working_dir: str | None = "/workspace/root",
    active_working_dir: str | None = "/workspace/other",
) -> dict[str, object]:
    pane_id = str(uuid.uuid4())
    return {
        "id": pane_id,
        "pane_type": "project",
        "project_id": "proj-1",
        "pane_name": "Project Pane",
        "pane_order": 0,
        "active_mode": "codex",
        "is_detached": False,
        "created_at": None,
        "sessions": [
            {
                "id": str(uuid.uuid4()),
                "mode": "shell",
                "working_dir": working_dir,
            },
            {
                "id": str(uuid.uuid4()),
                "mode": "codex",
                "working_dir": active_working_dir,
            },
        ],
        "width_percent": 100.0,
        "height_percent": 100.0,
        "grid_row": 0,
        "grid_col": 0,
    }


def test_get_pane_file_tree_uses_shell_working_dir(test_app: TestClient) -> None:
    pane = _pane_with_sessions()
    with (
        patch("a_term.api.pane_files.pane_store.get_pane_with_sessions", return_value=pane),
        patch("a_term.api.pane_files.Path.exists", return_value=True),
        patch("a_term.api.pane_files.Path.is_dir", return_value=True),
        patch(
            "a_term.api.pane_files.file_browser.list_directory",
            return_value={
                "entries": [],
                "path": "",
                "total": 0,
            },
        ) as list_directory,
    ):
        response = test_app.get(f"/api/a-term/panes/{pane['id']}/files/tree")

    assert response.status_code == 200
    assert "root" not in response.json()
    list_directory.assert_called_once_with("/workspace/root", "")


def test_get_pane_file_tree_requires_working_dir(test_app: TestClient) -> None:
    pane = _pane_with_sessions(working_dir=None, active_working_dir=None)
    with patch("a_term.api.pane_files.pane_store.get_pane_with_sessions", return_value=pane):
        response = test_app.get(f"/api/a-term/panes/{pane['id']}/files/tree")

    assert response.status_code == 400
    assert response.json()["detail"] == "Pane has no working directory"


def test_get_pane_file_tree_falls_back_to_active_session_working_dir(test_app: TestClient) -> None:
    pane = _pane_with_sessions(working_dir=None)
    with (
        patch("a_term.api.pane_files.pane_store.get_pane_with_sessions", return_value=pane),
        patch("a_term.api.pane_files.Path.exists", return_value=True),
        patch("a_term.api.pane_files.Path.is_dir", return_value=True),
        patch(
            "a_term.api.pane_files.file_browser.list_directory",
            return_value={
                "entries": [],
                "path": "",
                "total": 0,
            },
        ) as list_directory,
    ):
        response = test_app.get(f"/api/a-term/panes/{pane['id']}/files/tree")

    assert response.status_code == 200
    assert "root" not in response.json()
    list_directory.assert_called_once_with("/workspace/other", "")


def test_get_pane_file_content_returns_payload(test_app: TestClient) -> None:
    pane = _pane_with_sessions()
    with (
        patch("a_term.api.pane_files.pane_store.get_pane_with_sessions", return_value=pane),
        patch("a_term.api.pane_files.Path.exists", return_value=True),
        patch("a_term.api.pane_files.Path.is_dir", return_value=True),
        patch(
            "a_term.api.pane_files.file_browser.read_file",
            return_value={
                "path": "README.md",
                "name": "README.md",
                "content": "hello",
                "size": 5,
                "lines": 1,
                "extension": ".md",
                "is_binary": False,
                "language": "markdown",
                "truncated": False,
            },
        ),
    ):
        response = test_app.get(
            f"/api/a-term/panes/{pane['id']}/files/content",
            params={"path": "README.md"},
        )

    assert response.status_code == 200
    assert response.json()["path"] == "README.md"
    assert "absolute_path" not in response.json()


def test_get_pane_file_tree_translates_permission_errors(test_app: TestClient) -> None:
    pane = _pane_with_sessions()
    with (
        patch("a_term.api.pane_files.pane_store.get_pane_with_sessions", return_value=pane),
        patch("a_term.api.pane_files.Path.exists", return_value=True),
        patch("a_term.api.pane_files.Path.is_dir", return_value=True),
        patch(
            "a_term.api.pane_files.file_browser.list_directory",
            side_effect=PermissionError("Access denied: .git"),
        ),
    ):
        response = test_app.get(
            f"/api/a-term/panes/{pane['id']}/files/tree",
            params={"path": ".git"},
        )

    assert response.status_code == 403
    assert response.json()["detail"] == "Access denied: .git"
