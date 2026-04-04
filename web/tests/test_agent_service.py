"""Tests for synchronous agent startup helpers."""

from __future__ import annotations

import subprocess
from unittest.mock import call, patch

import pytest

from terminal.services.agent_service import (
    _is_agent_running_in_session_sync,
    ensure_agent_running_sync,
)


def test_is_agent_running_in_session_sync_matches_tmux_command_metadata() -> None:
    with patch(
        "terminal.services.agent_service.subprocess.run",
        return_value=subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="/dev/pts/1 codex bash\n",
            stderr="",
        ),
    ) as run_mock:
        assert _is_agent_running_in_session_sync("summitflow-codex-id", "codex") is True

    run_mock.assert_called_once_with(
        [
            "tmux",
            "list-panes",
            "-t",
            "summitflow-codex-id",
            "-F",
            "#{pane_tty} #{pane_current_command} #{pane_start_command}",
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )


def test_is_agent_running_in_session_sync_checks_pane_tty_processes_when_tmux_reports_shell() -> None:
    with patch(
        "terminal.services.agent_service.subprocess.run",
        side_effect=[
            subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="/dev/pts/4 bash bash\n",
                stderr="",
            ),
            subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=(
                    "768288 bash bash\n"
                    "768297 bash bash /home/tester/bin/codex --yolo\n"
                    "768369 MainThread node /usr/bin/codex --yolo\n"
                    "768376 codex /path/to/codex --yolo\n"
                ),
                stderr="",
            ),
        ],
    ) as run_mock:
        assert _is_agent_running_in_session_sync("summitflow-codex-id", "codex") is True

    assert run_mock.call_args_list == [
        call(
            [
                "tmux",
                "list-panes",
                "-t",
                "summitflow-codex-id",
                "-F",
                "#{pane_tty} #{pane_current_command} #{pane_start_command}",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        ),
        call(
            ["ps", "-t", "pts/4", "-o", "comm=,args="],
            capture_output=True,
            text=True,
            timeout=10,
        ),
    ]


def test_ensure_agent_running_sync_returns_false_for_shell_session() -> None:
    with patch(
        "terminal.services.agent_service.terminal_store.get_session",
        return_value={"id": "shell-id", "mode": "shell", "claude_state": "not_started"},
    ):
        assert ensure_agent_running_sync("shell-id") is False


def test_ensure_agent_running_sync_marks_existing_process_running() -> None:
    with (
        patch(
            "terminal.services.agent_service.terminal_store.get_session",
            return_value={"id": "codex-id", "mode": "codex", "claude_state": "not_started"},
        ),
        patch(
            "terminal.services.agent_service.agent_tools_store.get_by_slug",
            return_value={"command": "codex --yolo", "process_name": "codex"},
        ),
        patch("terminal.services.agent_service.lifecycle.ensure_session_alive", return_value=True),
        patch("terminal.services.agent_service._is_agent_running_in_session_sync", return_value=True),
        patch("terminal.services.agent_service.terminal_store.update_claude_state") as update_mock,
    ):
        assert ensure_agent_running_sync("codex-id") is False

    update_mock.assert_called_once_with("codex-id", "running")


def test_ensure_agent_running_sync_sends_command_and_verifies_startup() -> None:
    with (
        patch(
            "terminal.services.agent_service.terminal_store.get_session",
            return_value={"id": "claude-id", "mode": "claude", "claude_state": "not_started"},
        ),
        patch(
            "terminal.services.agent_service.agent_tools_store.get_by_slug",
            return_value={
                "command": "claude --dangerously-skip-permissions",
                "process_name": "claude",
            },
        ),
        patch("terminal.services.agent_service.lifecycle.ensure_session_alive", return_value=True),
        patch(
            "terminal.services.agent_service._is_agent_running_in_session_sync",
            side_effect=[False, True],
        ),
        patch("terminal.services.agent_service.atomically_set_starting", return_value=None),
        patch("terminal.services.agent_service.send_agent_command_sync", return_value=None) as send_mock,
        patch("terminal.services.agent_service.time.sleep"),
        patch("terminal.services.agent_service.terminal_store.update_claude_state") as update_mock,
    ):
        assert ensure_agent_running_sync("claude-id") is True

    send_mock.assert_called_once_with(
        "claude-id",
        "summitflow-claude-id",
        "claude --dangerously-skip-permissions",
    )
    assert update_mock.call_args_list == [call("claude-id", "running", expected_state="starting")]


def test_ensure_agent_running_sync_returns_false_when_tmux_cannot_be_restored() -> None:
    with (
        patch(
            "terminal.services.agent_service.terminal_store.get_session",
            return_value={"id": "codex-id", "mode": "codex", "claude_state": "not_started"},
        ),
        patch(
            "terminal.services.agent_service.agent_tools_store.get_by_slug",
            return_value={"command": "codex --yolo", "process_name": "codex"},
        ),
        patch("terminal.services.agent_service.lifecycle.ensure_session_alive", return_value=False) as ensure_mock,
        patch("terminal.services.agent_service._is_agent_running_in_session_sync") as running_mock,
        patch("terminal.services.agent_service.send_agent_command_sync") as send_mock,
        patch("terminal.services.agent_service.terminal_store.update_claude_state") as update_mock,
    ):
        assert ensure_agent_running_sync("codex-id") is False

    ensure_mock.assert_called_once_with("codex-id")
    running_mock.assert_not_called()
    send_mock.assert_not_called()
    update_mock.assert_called_once_with("codex-id", "error")


def test_ensure_agent_running_sync_returns_false_when_startup_verification_fails() -> None:
    with (
        patch(
            "terminal.services.agent_service.terminal_store.get_session",
            return_value={"id": "codex-id", "mode": "codex", "claude_state": "not_started"},
        ),
        patch(
            "terminal.services.agent_service.agent_tools_store.get_by_slug",
            return_value={"command": "codex --yolo", "process_name": "codex"},
        ),
        patch("terminal.services.agent_service.lifecycle.ensure_session_alive", return_value=True),
        patch(
            "terminal.services.agent_service._is_agent_running_in_session_sync",
            side_effect=[False, False],
        ),
        patch("terminal.services.agent_service.atomically_set_starting", return_value=None),
        patch("terminal.services.agent_service.send_agent_command_sync", return_value=None) as send_mock,
        patch("terminal.services.agent_service.time.sleep"),
        patch("terminal.services.agent_service.terminal_store.update_claude_state") as update_mock,
    ):
        assert ensure_agent_running_sync("codex-id") is False

    send_mock.assert_called_once_with("codex-id", "summitflow-codex-id", "codex --yolo")
    update_mock.assert_called_once_with("codex-id", "error", expected_state="starting")


def test_ensure_agent_running_sync_raises_for_missing_session() -> None:
    with (
        patch("terminal.services.agent_service.terminal_store.get_session", return_value=None),
        pytest.raises(ValueError, match="Session missing-id not found"),
    ):
        ensure_agent_running_sync("missing-id")
