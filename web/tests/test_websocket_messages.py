"""Tests for WebSocket control-message handling."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

from a_term.api.handlers.websocket_messages import handle_websocket_message


def test_handle_websocket_message_skips_tmux_resize_when_disabled() -> None:
    message = {"text": '{"__ctrl": true, "resize": {"cols": 90, "rows": 28}}'}

    with (
        patch("a_term.api.handlers.websocket_messages.resize_pty") as mock_resize_pty,
        patch("a_term.api.handlers.websocket_messages.resize_tmux_window") as mock_resize_tmux,
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


def test_handle_websocket_message_reclaims_external_tmux_size_when_dimensions_repeat() -> None:
    message = {"text": '{"__ctrl": true, "resize": {"cols": 90, "rows": 28}}'}
    last_resize = [0, 0]

    def run_tmux(args: list[str], *, socket_name: str) -> tuple[bool, str]:
        assert socket_name == "aico"
        if args[0] == "display-message":
            return True, "$2\t@7\taico-7"
        if args[0] == "list-windows":
            return True, "@7\n@8"
        if args[0] == "show-options":
            return True, "off"
        if args[0] == "resize-window":
            return True, ""
        raise AssertionError(args)

    with (
        patch("a_term.api.handlers.websocket_messages.resize_pty") as mock_resize_pty,
        patch("a_term.api.handlers.websocket_messages.run_tmux_command", side_effect=run_tmux) as mock_tmux,
    ):
        for _ in range(2):
            result = asyncio.run(
                handle_websocket_message(
                    message,
                    master_fd=7,
                    session_id="aico-7",
                    tmux_session_name="aico-7",
                    tmux_socket_name="aico",
                    last_resize=last_resize,
                    resize_tmux=True,
                    external_tmux_session_id="$2",
                )
            )

    assert result == (90, 28)
    assert last_resize == [90, 28]
    mock_resize_pty.assert_called_once_with(7, 90, 28)
    assert [call.args[0] for call in mock_tmux.call_args_list if call.args[0][0] == "resize-window"] == [
        ["resize-window", "-t", "@7", "-x", "90", "-y", "28"],
        ["resize-window", "-t", "@7", "-x", "90", "-y", "28"],
    ]


def test_external_resize_rejects_changed_or_unsafe_window() -> None:
    message = {"text": '{"__ctrl": true, "resize": {"cols": 90, "rows": 28}}'}
    cases = [
        ["$3\t@7\taico-7"],
        ["$2\t@7\taico-7", "@7\n@7"],
        ["$2\t@7\taico-7", "@7", "on"],
        ["$2\t@7\taico-7", "@7", "off", "$2\t@8\taico-7"],
    ]

    for responses in cases:
        with (
            patch("a_term.api.handlers.websocket_messages.resize_pty"),
            patch(
                "a_term.api.handlers.websocket_messages.run_tmux_command",
                side_effect=[(True, response) for response in responses],
            ) as mock_tmux,
        ):
            asyncio.run(
                handle_websocket_message(
                    message,
                    master_fd=7,
                    session_id="tmux:aico:aico-7",
                    tmux_session_name="aico-7",
                    tmux_socket_name="aico",
                    resize_tmux=True,
                    external_tmux_session_id="$2",
                )
            )
        assert all(call.args[0][0] != "resize-window" for call in mock_tmux.call_args_list)


def test_external_resize_without_verified_identity_never_claims_tmux() -> None:
    message = {"text": '{"__ctrl": true, "resize": {"cols": 90, "rows": 28}}'}

    with (
        patch("a_term.api.handlers.websocket_messages.resize_pty"),
        patch("a_term.api.handlers.websocket_messages.resize_tmux_window") as mock_resize,
        patch("a_term.api.handlers.websocket_messages.run_tmux_command") as mock_tmux,
    ):
        asyncio.run(
            handle_websocket_message(
                message,
                master_fd=7,
                session_id="tmux:aico:aico-7",
                tmux_session_name="aico-7",
                tmux_socket_name="aico",
                resize_tmux=True,
            )
        )

    mock_resize.assert_not_called()
    mock_tmux.assert_not_called()


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
        patch("a_term.api.handlers.websocket_messages.resize_pty"),
        patch("a_term.api.handlers.websocket_messages.resize_tmux_window"),
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


def test_capabilities_only_message_does_not_resize() -> None:
    message = {"text": '{"__ctrl": true, "capabilities": ["binary_protocol"]}'}
    capabilities: list[str] = []

    with (
        patch("a_term.api.handlers.websocket_messages.resize_pty") as mock_resize_pty,
        patch("a_term.api.handlers.websocket_messages.resize_tmux_window") as mock_resize_tmux,
    ):
        result = asyncio.run(
            handle_websocket_message(
                message,
                master_fd=7,
                session_id="session-passive",
                capabilities=capabilities,
            )
        )

    assert result is None
    assert capabilities == ["binary_protocol"]
    mock_resize_pty.assert_not_called()
    mock_resize_tmux.assert_not_called()


def test_handle_text_message_no_capabilities_when_absent() -> None:
    """Verify that capabilities list stays empty when resize has no capabilities field."""
    message = {"text": '{"__ctrl": true, "resize": {"cols": 80, "rows": 24}}'}
    capabilities: list[str] = []

    with (
        patch("a_term.api.handlers.websocket_messages.resize_pty"),
        patch("a_term.api.handlers.websocket_messages.resize_tmux_window"),
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


def test_handle_text_message_logs_renderer_status_without_writing_to_pty() -> None:
    message = {
        "text": json.dumps({
            "__ctrl": True,
            "renderer_status": {
                "renderer": "webgl",
                "webglContextAvailable": True,
                "webgl2ContextAvailable": True,
                "webglAddonLoaded": True,
                "canvasCount": 4,
                "termClassName": "terminal xterm",
                "userAgent": "Chrome",
            },
        })
    }

    with (
        patch("a_term.api.handlers.websocket_messages.os.write") as mock_write,
        patch("a_term.api.handlers.websocket_messages.logger") as mock_logger,
    ):
        result = asyncio.run(
            handle_websocket_message(
                message,
                master_fd=7,
                session_id="test-session",
                tmux_session_name="summitflow-test-session",
            )
        )

    assert result is None
    mock_write.assert_not_called()
    mock_logger.info.assert_called_once_with(
        "a_term_renderer_status",
        session_id="test-session",
        renderer="webgl",
        webgl_context_available=True,
        webgl2_context_available=True,
        webgl_addon_loaded=True,
        canvas_count=4,
        term_class_name="terminal xterm",
        user_agent="Chrome",
    )


def test_handle_websocket_message_resizes_tmux_for_managed_sessions() -> None:
    message = {"text": '{"__ctrl": true, "resize": {"cols": 120, "rows": 32}}'}

    with (
        patch("a_term.api.handlers.websocket_messages.resize_pty") as mock_resize_pty,
        patch("a_term.api.handlers.websocket_messages.resize_tmux_window") as mock_resize_tmux,
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
