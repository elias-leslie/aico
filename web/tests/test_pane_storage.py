"""Regression tests for pane storage session creation."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock, call, patch

import pytest

from aterm.storage import panes as pane_store
from aterm.utils.tmux import TmuxError


def _mock_connection(cursor: MagicMock) -> MagicMock:
    """Build a connection context manager that yields the provided cursor."""
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    manager = MagicMock()
    manager.__enter__.return_value = conn
    manager.__exit__.return_value = False
    return manager


def test_create_project_pane_creates_tmux_backed_sessions() -> None:
    cursor = MagicMock()
    cursor.fetchone.side_effect = [
        {"cnt": 0},
        {
            "id": "pane-1",
            "pane_type": "project",
            "project_id": "monkey-fight",
            "pane_order": 0,
            "pane_name": "Monkey Fight",
            "active_mode": "shell",
            "is_detached": False,
            "created_at": datetime.now(UTC),
            "width_percent": 100.0,
            "height_percent": 100.0,
            "grid_row": 0,
            "grid_col": 0,
        },
    ]

    shell_session = {
        "id": "shell-id",
        "name": "Project: monkey-fight",
        "mode": "shell",
        "session_number": 1,
        "is_alive": True,
        "working_dir": "/workspace/monkey-fight",
        "claude_state": "not_started",
        "pane_id": "pane-1",
    }
    agent_session = {
        "id": "claude-id",
        "name": "Project: monkey-fight",
        "mode": "claude",
        "session_number": 1,
        "is_alive": True,
        "working_dir": "/workspace/monkey-fight",
        "claude_state": "not_started",
        "pane_id": "pane-1",
    }

    with (
        patch("aterm.storage.panes.get_connection", return_value=_mock_connection(cursor)),
        patch("aterm.storage.panes._get_default_agent_slug", return_value="claude"),
        patch("aterm.storage.panes.create_aterm_session", side_effect=["shell-id", "claude-id"]) as create_session_mock,
        patch("aterm.storage.panes.create_tmux_session") as create_tmux_mock,
        patch("aterm.storage.panes.get_aterm_session", side_effect=[shell_session, agent_session]),
    ):
        pane = pane_store.create_pane_with_sessions(
            pane_type="project",
            pane_name="Monkey Fight",
            project_id="monkey-fight",
            working_dir="/workspace/monkey-fight",
            pane_order=0,
        )

    assert pane["active_mode"] == "shell"
    assert [session["mode"] for session in pane["sessions"]] == ["shell", "claude"]
    assert create_session_mock.call_args_list == [
        call(
            name="Project: monkey-fight",
            project_id="monkey-fight",
            working_dir="/workspace/monkey-fight",
            mode="shell",
            pane_id="pane-1",
        ),
        call(
            name="Project: monkey-fight",
            project_id="monkey-fight",
            working_dir="/workspace/monkey-fight",
            mode="claude",
            pane_id="pane-1",
        ),
    ]
    assert create_tmux_mock.call_args_list == [
        call("shell-id", "/workspace/monkey-fight"),
        call("claude-id", "/workspace/monkey-fight"),
    ]


def test_create_project_pane_rolls_back_on_agent_tmux_failure() -> None:
    cursor = MagicMock()
    cursor.fetchone.side_effect = [
        {"cnt": 0},
        {
            "id": "pane-1",
            "pane_type": "project",
            "project_id": "monkey-fight",
            "pane_order": 0,
            "pane_name": "Monkey Fight",
            "active_mode": "shell",
            "is_detached": False,
            "created_at": datetime.now(UTC),
            "width_percent": 100.0,
            "height_percent": 100.0,
            "grid_row": 0,
            "grid_col": 0,
        },
    ]

    shell_session = {
        "id": "shell-id",
        "name": "Project: monkey-fight",
        "mode": "shell",
        "session_number": 1,
        "is_alive": True,
        "working_dir": "/workspace/monkey-fight",
        "claude_state": "not_started",
        "pane_id": "pane-1",
    }

    with (
        patch("aterm.storage.panes.get_connection", return_value=_mock_connection(cursor)),
        patch("aterm.storage.panes._get_default_agent_slug", return_value="claude"),
        patch("aterm.storage.panes.create_aterm_session", side_effect=["shell-id", "claude-id"]),
        patch(
            "aterm.storage.panes.create_tmux_session",
            side_effect=[None, TmuxError("boom")],
        ),
        patch("aterm.storage.panes.get_aterm_session", return_value=shell_session),
        patch("aterm.storage.panes.delete_aterm_session") as delete_session_mock,
        patch("aterm.storage.panes.run_tmux_command") as run_tmux_command_mock,
        patch("aterm.storage.panes.delete_pane") as delete_pane_mock,
        pytest.raises(TmuxError, match="boom"),
    ):
        pane_store.create_pane_with_sessions(
                pane_type="project",
                pane_name="Monkey Fight",
                project_id="monkey-fight",
                working_dir="/workspace/monkey-fight",
                pane_order=0,
            )

    assert delete_session_mock.call_args_list == [call("claude-id"), call("shell-id")]
    run_tmux_command_mock.assert_called_once_with(["kill-session", "-t", "summitflow-shell-id"])
    delete_pane_mock.assert_called_once_with("pane-1")
