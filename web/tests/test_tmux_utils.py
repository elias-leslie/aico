"""Tests for tmux utility functions."""

from __future__ import annotations

from unittest.mock import MagicMock, call, patch

import pytest

from a_term.utils import tmux
from a_term.utils.tmux import (
    TMUX_SESSION_PREFIX,
    apply_external_attach_options,
    create_tmux_session,
    get_cursor_position,
    get_external_agent_tmux_session,
    get_tmux_session_name,
    is_managed_tmux_session_name,
    list_external_agent_tmux_sessions,
    list_tmux_sessions,
    reset_tmux_window_size_policy,
    restore_external_attach_options,
    validate_session_name,
)
from a_term.utils.tmux.sessions import (
    _build_tmux_scope_env,
    _recreate_initial_window_with_session_history_limit,
    _run_tmux_new_session,
)


@pytest.fixture(autouse=True)
def clear_external_attach_state():
    tmux._EXTERNAL_ATTACH_STATES.clear()
    yield
    tmux._EXTERNAL_ATTACH_STATES.clear()


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


class TestSessionNameHelpers:
    def test_get_tmux_session_name(self) -> None:
        assert get_tmux_session_name("abc") == f"{TMUX_SESSION_PREFIX}abc"

    def test_is_managed_with_uuid(self) -> None:
        assert is_managed_tmux_session_name("summitflow-123e4567-e89b-12d3-a456-426614174000") is True

    def test_is_managed_without_prefix(self) -> None:
        assert is_managed_tmux_session_name("other-session") is False

    def test_is_managed_with_prefix_but_not_uuid(self) -> None:
        assert is_managed_tmux_session_name("summitflow-not-a-uuid") is False


class TestListTmuxSessions:
    def test_returns_uuids_only(self) -> None:
        output = "\n".join([
            "summitflow-123e4567-e89b-12d3-a456-426614174000",
            "summitflow-not-a-uuid",
            "other-session",
        ])
        with patch("a_term.utils.tmux.run_tmux_command", return_value=(True, output)):
            result = list_tmux_sessions()
        assert result == {"123e4567-e89b-12d3-a456-426614174000"}

    def test_returns_empty_on_failure(self) -> None:
        with patch("a_term.utils.tmux.run_tmux_command", return_value=(False, "error")):
            assert list_tmux_sessions() == set()


def test_list_external_agent_tmux_sessions_discovers_non_a_term_agent_sessions() -> None:
    with (
        patch(
            "a_term.utils.tmux.run_tmux_command",
            return_value=(
                True,
                "\n".join(
                    [
                        "claude-summitflow\t%1\t/home/testuser/summitflow\tclaude",
                        "summitflow-123e4567-e89b-12d3-a456-426614174000\t%2\t/home/testuser/summitflow\tbash",
                        "codex-agent-hub\t%3\t/home/testuser/agent-hub\tcodex",
                    ]
                ),
            ),
        ),
        patch("a_term.utils.tmux.subprocess.run") as mock_subprocess,
    ):
        mock_subprocess.side_effect = [
            MagicMock(stdout="/home/testuser/summitflow\n"),
            MagicMock(stdout="/home/testuser/agent-hub\n"),
        ]
        sessions = list_external_agent_tmux_sessions()

    assert [session["id"] for session in sessions] == ["claude-summitflow", "codex-agent-hub"]
    assert sessions[0]["project_id"] == "summitflow"
    assert sessions[0]["mode"] == "claude"
    assert sessions[1]["project_id"] == "agent-hub"
    assert sessions[1]["mode"] == "codex"


def test_create_tmux_session_uses_systemd_scope_when_available() -> None:
    scope_id = "123e4567-e89b-12d3-a456-426614174000"
    with (
        patch("a_term.utils.tmux.tmux_session_exists", return_value=False),
        patch("a_term.utils.tmux._apply_session_options") as mock_apply,
        patch(
            "a_term.utils.tmux.sessions._recreate_initial_window_with_session_history_limit"
        ) as mock_recreate,
        patch("a_term.utils.tmux._can_spawn_tmux_scope", return_value=True),
        patch(
            "a_term.utils.tmux.subprocess.run",
            return_value=MagicMock(returncode=0, stdout="", stderr=""),
        ) as mock_run,
        patch("a_term.utils.tmux._uuid_mod.uuid4", return_value=scope_id),
    ):
        session_name = create_tmux_session("abc123", working_dir="/tmp/project")

    assert session_name == "summitflow-abc123"
    command = mock_run.call_args.args[0]
    assert command[:4] == ["systemd-run", "--user", "--scope", "--quiet"]
    assert f"--unit=tmux-spawn-{scope_id}" in command
    assert command[-11:] == [
        "tmux",
        "new-session",
        "-d",
        "-s",
        "summitflow-abc123",
        "-x",
        str(tmux.TMUX_DEFAULT_COLS),
        "-y",
        str(tmux.TMUX_DEFAULT_ROWS),
        "-c",
        "/tmp/project",
    ]
    mock_apply.assert_called_once_with("summitflow-abc123", True)
    mock_recreate.assert_called_once_with("summitflow-abc123", "/tmp/project")


def test_create_tmux_session_falls_back_without_user_scope_support() -> None:
    with (
        patch("a_term.utils.tmux.tmux_session_exists", return_value=False),
        patch("a_term.utils.tmux._apply_session_options") as mock_apply,
        patch(
            "a_term.utils.tmux.sessions._recreate_initial_window_with_session_history_limit"
        ) as mock_recreate,
        patch("a_term.utils.tmux._can_spawn_tmux_scope", return_value=False),
        patch("a_term.utils.tmux.run_tmux_command", return_value=(True, "")) as mock_run,
    ):
        session_name = create_tmux_session("abc123", working_dir="/tmp/project")

    assert session_name == "summitflow-abc123"
    mock_run.assert_called_once_with(
        [
            "new-session",
            "-d",
            "-s",
            "summitflow-abc123",
            "-x",
            str(tmux.TMUX_DEFAULT_COLS),
            "-y",
            str(tmux.TMUX_DEFAULT_ROWS),
            "-c",
            "/tmp/project",
        ]
    )
    mock_apply.assert_called_once_with("summitflow-abc123", True)
    mock_recreate.assert_called_once_with("summitflow-abc123", "/tmp/project")


def test_build_tmux_scope_env_drops_blank_companion_vars(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_HUB_URL", "   ")
    monkeypatch.setenv("NEXT_PUBLIC_AGENT_HUB_URL", "")
    monkeypatch.setenv("SUMMITFLOW_API_BASE", " http://127.0.0.1:8001/api ")
    monkeypatch.setenv("UNCHANGED_ENV", "keep-me")

    env = _build_tmux_scope_env()

    assert "AGENT_HUB_URL" not in env
    assert "NEXT_PUBLIC_AGENT_HUB_URL" not in env
    assert env["SUMMITFLOW_API_BASE"] == "http://127.0.0.1:8001/api"
    assert env["UNCHANGED_ENV"] == "keep-me"


def test_run_tmux_new_session_uses_sanitized_scope_env(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_HUB_URL", "")
    monkeypatch.setenv("NEXT_PUBLIC_AGENT_HUB_URL", "")
    monkeypatch.setenv("SUMMITFLOW_API_BASE", " http://127.0.0.1:8001/api ")
    monkeypatch.setenv("UNCHANGED_ENV", "keep-me")

    with (
        patch("a_term.utils.tmux._can_spawn_tmux_scope", return_value=True),
        patch(
            "a_term.utils.tmux.subprocess.run",
            return_value=MagicMock(returncode=0, stdout="", stderr=""),
        ) as mock_run,
        patch("a_term.utils.tmux._uuid_mod.uuid4", return_value="123e4567-e89b-12d3-a456-426614174000"),
    ):
        success, output = _run_tmux_new_session(["new-session", "-d"], "summitflow-abc123")

    assert success is True
    assert output == ""
    env = mock_run.call_args.kwargs["env"]
    assert "AGENT_HUB_URL" not in env
    assert "NEXT_PUBLIC_AGENT_HUB_URL" not in env
    assert env["SUMMITFLOW_API_BASE"] == "http://127.0.0.1:8001/api"
    assert env["UNCHANGED_ENV"] == "keep-me"


def test_recreate_initial_window_with_session_history_limit_replaces_bootstrap_window() -> None:
    with patch(
        "a_term.utils.tmux.run_tmux_command",
        side_effect=[
            (True, "0"),
            (True, "1"),
            (True, ""),
            (True, ""),
        ],
    ) as mock_run:
        _recreate_initial_window_with_session_history_limit(
            "summitflow-abc123",
            "/tmp/project",
        )

    assert mock_run.call_args_list == [
        call(
            ["display-message", "-p", "-t", "summitflow-abc123", "#{window_index}"],
            check=True,
        ),
        call(
            [
                "new-window",
                "-dP",
                "-F",
                "#{window_index}",
                "-t",
                "summitflow-abc123",
                "-c",
                "/tmp/project",
            ],
            check=True,
        ),
        call(["select-window", "-t", "summitflow-abc123:1"], check=True),
        call(["kill-window", "-t", "summitflow-abc123:0"], check=True),
    ]


def test_get_external_agent_tmux_session_matches_by_name() -> None:
    session = {
        "id": "claude-summitflow",
        "tmux_session_name": "claude-summitflow",
        "is_external": True,
    }
    with patch("a_term.utils.tmux.list_external_agent_tmux_sessions", return_value=[session]):
        assert get_external_agent_tmux_session("claude-summitflow") == session


def test_get_cursor_position_returns_coordinates() -> None:
    with patch(
        "a_term.utils.tmux.run_tmux_command",
        return_value=(True, "12\t34"),
    ):
        assert get_cursor_position("codex-agent-hub") == (12, 34)


def test_get_cursor_position_returns_none_on_invalid_output() -> None:
    with patch(
        "a_term.utils.tmux.run_tmux_command",
        return_value=(True, "not-a-position"),
    ):
        assert get_cursor_position("codex-agent-hub") is None


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
