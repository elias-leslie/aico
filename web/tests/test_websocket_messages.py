"""Tests for WebSocket control-message handling."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

from aterm.api.handlers.websocket_messages import handle_websocket_message


def test_handle_websocket_message_skips_tmux_resize_for_external_sessions() -> None:
    message = {"text": '{"__ctrl": true, "resize": {"cols": 90, "rows": 28}}'}

    with (
        patch("aterm.api.handlers.websocket_messages.resize_pty") as mock_resize_pty,
        patch("aterm.api.handlers.websocket_messages.resize_tmux_window") as mock_resize_tmux,
    ):
        result = asyncio.run(
            handle_websocket_message(
                message,
                master_fd=7,
                session_id="codex-agent-hub",
                tmux_session_name="codex-agent-hub",
                resize_tmux=False,
            )
        )

    assert result == (90, 28)
    mock_resize_pty.assert_called_once_with(7, 90, 28)
    mock_resize_tmux.assert_not_called()


def test_handle_text_message_extracts_capabilities() -> None:
    """Verify that capabilities array is extracted from initial resize message."""
    message = {
        "text": json.dumps({
            "__ctrl": True,
            "resize": {"cols": 80, "rows": 24},
            "capabilities": ["backpressure", "diff_sync", "binary_protocol", "demand_paging"],
        })
    }
    capabilities: list[str] = []

    with (
        patch("aterm.api.handlers.websocket_messages.resize_pty"),
        patch("aterm.api.handlers.websocket_messages.resize_tmux_window"),
    ):
        asyncio.run(
            handle_websocket_message(
                message,
                master_fd=7,
                session_id="test-session",
                tmux_session_name="summitflow-test-session",
                capabilities=capabilities,
            )
        )

    assert capabilities == ["backpressure", "diff_sync", "binary_protocol", "demand_paging"]


def test_handle_text_message_no_capabilities_when_absent() -> None:
    """Verify that capabilities list stays empty when resize has no capabilities field."""
    message = {"text": '{"__ctrl": true, "resize": {"cols": 80, "rows": 24}}'}
    capabilities: list[str] = []

    with (
        patch("aterm.api.handlers.websocket_messages.resize_pty"),
        patch("aterm.api.handlers.websocket_messages.resize_tmux_window"),
    ):
        asyncio.run(
            handle_websocket_message(
                message,
                master_fd=7,
                session_id="test-session",
                tmux_session_name="summitflow-test-session",
                capabilities=capabilities,
            )
        )

    assert capabilities == []


def test_handle_websocket_message_resizes_tmux_for_managed_sessions() -> None:
    message = {"text": '{"__ctrl": true, "resize": {"cols": 120, "rows": 32}}'}

    with (
        patch("aterm.api.handlers.websocket_messages.resize_pty") as mock_resize_pty,
        patch("aterm.api.handlers.websocket_messages.resize_tmux_window") as mock_resize_tmux,
    ):
        result = asyncio.run(
            handle_websocket_message(
                message,
                master_fd=9,
                session_id="123e4567-e89b-12d3-a456-426614174000",
                tmux_session_name="summitflow-123e4567-e89b-12d3-a456-426614174000",
            )
        )

    assert result == (120, 32)
    mock_resize_pty.assert_called_once_with(9, 120, 32)
    mock_resize_tmux.assert_called_once_with(
        "summitflow-123e4567-e89b-12d3-a456-426614174000",
        120,
        32,
    )
