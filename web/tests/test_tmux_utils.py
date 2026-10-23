"""Tests for tmux utility functions."""

from __future__ import annotations

from unittest.mock import call, patch

import pytest

from a_term.utils import tmux
from a_term.utils.tmux import (
    apply_external_attach_options,
    build_tmux_command,
    reset_tmux_window_size_policy,
    restore_external_attach_options,
    validate_session_name,
    validate_socket_name,
)


@pytest.fixture(autouse=True)
def clear_external_attach_state():
    tmux._EXTERNAL_ATTACH_STATES.clear()
    yield
    tmux._EXTERNAL_ATTACH_STATES.clear()


SOCKET = "/home/testuser/.local/state/tether/tmux/abc12345/server.sock"


class TestValidateSessionName:
    def test_valid_names(self) -> None:
        assert validate_session_name("abc123") is True
        assert validate_session_name("my-session_1") is True
        assert validate_session_name("A") is True

    def test_invalid_names(self) -> None:
        assert validate_session_name("") is False
        assert validate_session_name("has space") is False
        assert validate_session_name("has;semicolon") is False
        assert validate_session_name("a" * 256) is False


class TestValidateSocketName:
    def test_accepts_default_server_and_safe_absolute_sockets(self) -> None:
        assert validate_socket_name(None) is True
        assert validate_socket_name("/home/testuser/.local/state/tether/tmux/abc12345/server.sock")

    def test_rejects_named_sockets(self) -> None:
        # ``tmux -L name`` selectors belonged to the Aico federation and are gone.
        assert validate_socket_name("aico") is False
        assert validate_socket_name("default") is False

    @pytest.mark.parametrize(
        "socket_name",
        [
            "relative/path",
            "aico\n",
            "/tmp/../aico.sock",
            "/tmp//aico.sock",
            "/tmp/aico socket",
            "/tmp/aico:semicolon",
            "/" + "a" * 107,
        ],
    )
    def test_rejects_unsafe_socket_selectors(self, socket_name: str) -> None:
        assert validate_socket_name(socket_name) is False

    def test_build_tmux_command_default_server_has_no_socket_flag(self) -> None:
        assert build_tmux_command(["list-sessions"]) == ["tmux", "list-sessions"]

    def test_build_tmux_command_rejects_named_socket(self) -> None:
        with pytest.raises(tmux.TmuxError):
            build_tmux_command(["list-sessions"], "aico")

    def test_build_tmux_command_uses_absolute_socket_path(self) -> None:
        socket_path = "/home/testuser/.local/state/tether/tmux/abc12345/server.sock"
        assert build_tmux_command(["list-sessions"], socket_path) == [
            "tmux",
            "-S",
            socket_path,
            "list-sessions",
        ]


def test_reset_tmux_window_size_policy_sets_latest() -> None:
    with patch("a_term.utils.tmux.run_tmux_command", return_value=(True, "")) as mock_run:
        assert reset_tmux_window_size_policy("codex-agent-hub") is True

    mock_run.assert_called_once_with(
        ["set-window-option", "-t", "codex-agent-hub", "window-size", "latest"]
    )


def test_apply_external_attach_options_refcounts_and_restores_original_values() -> None:
    with patch(
        "a_term.utils.tmux.run_tmux_command",
        side_effect=[
            (True, "on"),
            (True, "on"),
            (True, ""),
            (True, ""),
            (True, ""),
            (True, ""),
        ],
    ) as mock_run:
        assert apply_external_attach_options("codex-agent-hub") is True
        assert apply_external_attach_options("codex-agent-hub") is True
        assert restore_external_attach_options("codex-agent-hub") is True
        assert restore_external_attach_options("codex-agent-hub") is True

    assert mock_run.call_args_list == [
        call(["show-options", "-qv", "-t", "codex-agent-hub", "status"]),
        call(["show-options", "-qv", "-t", "codex-agent-hub", "mouse"]),
        call(["set-option", "-t", "codex-agent-hub", "status", "off"]),
        call(["set-option", "-t", "codex-agent-hub", "mouse", "off"]),
        call(["set-option", "-t", "codex-agent-hub", "mouse", "on"]),
        call(["set-option", "-t", "codex-agent-hub", "status", "on"]),
    ]


def test_apply_external_attach_options_rolls_back_partial_changes() -> None:
    with patch(
        "a_term.utils.tmux.run_tmux_command",
        side_effect=[
            (True, "on"),
            (True, "on"),
            (True, ""),
            (False, "failed"),
            (True, ""),
        ],
    ) as mock_run:
        assert apply_external_attach_options("codex-agent-hub") is False

    assert mock_run.call_args_list == [
        call(["show-options", "-qv", "-t", "codex-agent-hub", "status"]),
        call(["show-options", "-qv", "-t", "codex-agent-hub", "mouse"]),
        call(["set-option", "-t", "codex-agent-hub", "status", "off"]),
        call(["set-option", "-t", "codex-agent-hub", "mouse", "off"]),
        call(["set-option", "-t", "codex-agent-hub", "status", "on"]),
    ]


def test_apply_external_attach_options_targets_the_given_socket() -> None:
    with patch(
        "a_term.utils.tmux.run_tmux_command",
        side_effect=[
            (True, "on"),
            (True, "off"),
            (True, ""),
            (True, ""),
        ],
    ) as mock_run:
        assert apply_external_attach_options("tether-7", SOCKET) is True
        assert restore_external_attach_options("tether-7", SOCKET) is True

    assert mock_run.call_args_list == [
        call(["show-options", "-qv", "-t", "tether-7", "status"], socket_name=SOCKET),
        call(["show-options", "-qv", "-t", "tether-7", "mouse"], socket_name=SOCKET),
        call(["set-option", "-t", "tether-7", "status", "off"], socket_name=SOCKET),
        call(["set-option", "-t", "tether-7", "status", "on"], socket_name=SOCKET),
    ]
