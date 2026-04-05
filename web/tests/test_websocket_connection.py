"""Tests for WebSocket connection lifecycle helpers."""

from __future__ import annotations

import json
from unittest.mock import ANY, AsyncMock, MagicMock, call, patch

import pytest

from aterm.api.handlers.websocket_connection import _run_session, _setup_connection
from aterm.constants import SHELL_MODE


@pytest.mark.asyncio
async def test_setup_connection_applies_external_attach_options() -> None:
    session = {
        "is_external": True,
        "mode": "codex",
        "last_claude_session": None,
    }
    websocket = AsyncMock()

    with (
        patch(
            "aterm.api.handlers.websocket_connection.validate_and_prepare_session",
            return_value=(session, "codex-agent-hub"),
        ),
        patch(
            "aterm.api.handlers.websocket_connection.reset_tmux_window_size_policy",
            return_value=True,
        ) as mock_reset,
        patch(
            "aterm.api.handlers.websocket_connection.apply_external_attach_options",
            return_value=True,
        ) as mock_apply,
        patch(
            "aterm.api.handlers.websocket_connection.spawn_pty_for_tmux",
            return_value=(17, 23),
        ),
        patch(
            "aterm.api.handlers.websocket_connection._wait_for_initial_resize",
            new=AsyncMock(),
        ) as mock_wait,
        patch(
            "aterm.api.handlers.websocket_connection.get_scrollback",
            return_value=None,
        ),
    ):
        result = await _setup_connection(websocket, "codex-agent-hub", [])

    assert result == (session, "codex-agent-hub", 17, 23, False)
    mock_reset.assert_called_once_with("codex-agent-hub")
    mock_apply.assert_called_once_with("codex-agent-hub")
    mock_wait.assert_awaited_once()


@pytest.mark.asyncio
async def test_setup_connection_restores_external_attach_options_after_setup_failure() -> None:
    session = {
        "is_external": True,
        "mode": "codex",
        "last_claude_session": None,
    }
    websocket = AsyncMock()

    with (
        patch(
            "aterm.api.handlers.websocket_connection.validate_and_prepare_session",
            return_value=(session, "codex-agent-hub"),
        ),
        patch(
            "aterm.api.handlers.websocket_connection.reset_tmux_window_size_policy",
            return_value=True,
        ) as mock_reset,
        patch(
            "aterm.api.handlers.websocket_connection.apply_external_attach_options",
            return_value=True,
        ),
        patch(
            "aterm.api.handlers.websocket_connection.restore_external_attach_options",
            return_value=True,
        ) as mock_restore,
        patch(
            "aterm.api.handlers.websocket_connection.spawn_pty_for_tmux",
            return_value=(17, 23),
        ),
        patch(
            "aterm.api.handlers.websocket_connection._wait_for_initial_resize",
            new=AsyncMock(side_effect=RuntimeError("resize failed")),
        ),pytest.raises(RuntimeError, match="resize failed")
    ):
        await _setup_connection(websocket, "codex-agent-hub", [])

    mock_restore.assert_called_once_with("codex-agent-hub")
    assert mock_reset.call_args_list == [
        call("codex-agent-hub"),
        call("codex-agent-hub"),
    ]


@pytest.mark.asyncio
async def test_setup_connection_sends_initial_shell_scrollback_as_control_snapshot() -> None:
    session = {
        "is_external": False,
        "mode": SHELL_MODE,
        "last_claude_session": None,
    }
    websocket = AsyncMock()

    with (
        patch(
            "aterm.api.handlers.websocket_connection.validate_and_prepare_session",
            return_value=(session, "summitflow-shell"),
        ),
        patch(
            "aterm.api.handlers.websocket_connection.spawn_pty_for_tmux",
            return_value=(17, 23),
        ),
        patch(
            "aterm.api.handlers.websocket_connection._wait_for_initial_resize",
            new=AsyncMock(),
        ),
        patch(
            "aterm.api.handlers.websocket_connection.get_scrollback_with_cursor",
            return_value=("line 1\nline 2\n", (4, 9)),
        ),
    ):
        result = await _setup_connection(websocket, "session-1", [])

    assert result == (session, "summitflow-shell", 17, 23, True)
    websocket.send_text.assert_awaited_once()
    payload = json.loads(websocket.send_text.await_args.args[0])
    assert payload == {
        "__ctrl": True,
        "scrollback_sync": "line 1\r\nline 2\r\n",
        "scrollback_cursor_x": 4,
        "scrollback_cursor_y": 9,
    }


@pytest.mark.asyncio
async def test_setup_connection_sends_initial_scrollback_page_for_agent_sessions() -> None:
    session = {
        "is_external": False,
        "mode": "claude",
        "last_claude_session": None,
    }
    websocket = AsyncMock()

    with (
        patch(
            "aterm.api.handlers.websocket_connection.validate_and_prepare_session",
            return_value=(session, "summitflow-agent"),
        ),
        patch(
            "aterm.api.handlers.websocket_connection.spawn_pty_for_tmux",
            return_value=(17, 23),
        ),
        patch(
            "aterm.api.handlers.websocket_connection._wait_for_initial_resize",
            new=AsyncMock(),
        ),
        patch(
            "aterm.api.handlers.websocket_connection.get_scrollback",
            return_value="line 1\nline 2\n",
        ),
    ):
        result = await _setup_connection(websocket, "session-1", [])

    assert result == (session, "summitflow-agent", 17, 23, True)
    websocket.send_text.assert_awaited_once()
    payload = json.loads(websocket.send_text.await_args.args[0])
    assert payload == {
        "__ctrl": True,
        "scrollback_page": {
            "from_line": 0,
            "lines": ["line 1", "line 2"],
            "total_lines": 2,
        },
    }


@pytest.mark.asyncio
async def test_run_session_restores_external_attach_options_on_disconnect() -> None:
    websocket = AsyncMock()
    session = {"is_external": True, "mode": "codex"}

    with (
        patch(
            "aterm.api.handlers.websocket_connection._setup_connection",
            new=AsyncMock(return_value=(session, "codex-agent-hub", 17, 23, False)),
        ),
        patch(
            "aterm.api.handlers.websocket_connection._run_message_loop",
            new=AsyncMock(),
        ),
        patch(
            "aterm.api.handlers.websocket_connection.read_pty_output",
            new=AsyncMock(),
        ),
        patch(
            "aterm.api.handlers.websocket_connection._heartbeat_loop",
            new=AsyncMock(),
        ),
        patch(
            "aterm.api.handlers.websocket_connection.restore_external_attach_options",
            return_value=True,
        ) as mock_restore,
        patch(
            "aterm.api.handlers.websocket_connection.reset_tmux_window_size_policy",
            return_value=True,
        ) as mock_reset,
    ):
        result = await _run_session(websocket, "codex-agent-hub")

    assert result == (23, 17)
    mock_restore.assert_called_once_with("codex-agent-hub")
    mock_reset.assert_called_once_with("codex-agent-hub")


# Scrollback sync MUST be enabled for ALL session modes. Agent/TUI sessions
# use the alternate screen buffer — xterm.js doesn't accumulate scrollback
# from alternate-buffer output. The periodic tmux capture-pane snapshots are
# the ONLY source of scrollable history. Disabling sync for non-shell sessions
# was tried and immediately broke scrolling (2026-03-18).


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode,tmux_name,is_external",
    [
        ("shell", "summitflow-shell", False),
        ("claude", "summitflow-agent", True),
        ("codex", "summitflow-codex", True),
    ],
    ids=["shell", "agent-claude", "agent-codex"],
)
async def test_run_session_enables_scrollback_sync_for_all_modes(
    mode: str,
    tmux_name: str,
    is_external: bool,
) -> None:
    """Scrollback sync is created for shell and TUI sessions alike."""
    websocket = AsyncMock()
    session = {"is_external": is_external, "mode": mode}
    scheduler = MagicMock()
    scheduler.close = AsyncMock()
    tracker = MagicMock()

    with (
        patch(
            "aterm.api.handlers.websocket_connection._setup_connection",
            new=AsyncMock(return_value=(session, tmux_name, 17, 23, not is_external)),
        ),
        patch(
            "aterm.api.handlers.websocket_connection._run_message_loop",
            new=AsyncMock(),
        ),
        patch(
            "aterm.api.handlers.websocket_connection.read_pty_output",
            new=AsyncMock(),
        ),
        patch(
            "aterm.api.handlers.websocket_connection._heartbeat_loop",
            new=AsyncMock(),
        ),
        patch(
            "aterm.api.handlers.websocket_connection.ScrollbackSyncScheduler",
            return_value=scheduler,
        ) as mock_scheduler_cls,
        patch(
            "aterm.api.handlers.websocket_connection.ScrollbackSyncOutputTracker",
            return_value=tracker,
        ) as mock_tracker_cls,
        patch(
            "aterm.api.handlers.websocket_connection.restore_external_attach_options",
            return_value=True,
        ) as mock_restore,
        patch(
            "aterm.api.handlers.websocket_connection.reset_tmux_window_size_policy",
            return_value=True,
        ) as mock_reset,
    ):
        result = await _run_session(websocket, tmux_name)

    assert result == (23, 17)
    mock_scheduler_cls.assert_called_once_with(
        websocket, tmux_name, use_binary=False, diff_tracker=None, diag=ANY,
    )
    mock_tracker_cls.assert_called_once_with(
        scheduler,
        min_lines=40,
    )
    scheduler.set_output_tracker.assert_called_once_with(tracker)
    scheduler.close.assert_awaited_once()
    if is_external:
        mock_restore.assert_called_once_with(tmux_name)
        mock_reset.assert_called_once_with(tmux_name)
    else:
        mock_restore.assert_not_called()
        mock_reset.assert_not_called()
