"""Tests for tmux utility functions."""

from __future__ import annotations

from unittest.mock import MagicMock, call, patch

import pytest

from a_term.utils import tmux
from a_term.utils.tmux import (
    TMUX_SESSION_PREFIX,
    apply_external_attach_options,
    build_tmux_command,
    create_tmux_session,
    get_cursor_position,
    get_external_agent_tmux_session,
    get_scrollback_with_cursor,
    get_tmux_session_name,
    is_managed_tmux_session_name,
    list_external_agent_tmux_sessions,
    list_tmux_sessions,
    reset_tmux_window_size_policy,
    restore_external_attach_options,
    validate_session_name,
    validate_socket_name,
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


class TestValidateSocketName:
    def test_accepts_named_and_safe_absolute_sockets(self) -> None:
        assert validate_socket_name("aico") is True
        assert validate_socket_name("/home/testuser/.local/state/aico/tmux/abc12345/server.sock")

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

    def test_build_tmux_command_preserves_named_socket_compatibility(self) -> None:
        assert build_tmux_command(["list-sessions"], "aico") == [
            "tmux",
            "-L",
            "aico",
            "list-sessions",
        ]

    def test_build_tmux_command_uses_absolute_socket_path(self) -> None:
        socket_path = "/home/testuser/.local/state/aico/tmux/abc12345/server.sock"
        assert build_tmux_command(["list-sessions"], socket_path) == [
            "tmux",
            "-S",
            socket_path,
            "list-sessions",
        ]


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
                        "hermes-research\t%4\t/home/testuser/research\thermes",
                        "pi-a-term\t%5\t/home/testuser/a-term\tpi",
                        "agy-antigravity\t%6\t/home/testuser/antigravity\tagy",
                    ]
                ),
            ),
        ),
        patch("a_term.utils.tmux.external._catalogued_aico_tmux_sources", return_value=()),
        patch("a_term.utils.tmux.subprocess.run") as mock_subprocess,
    ):
        mock_subprocess.side_effect = [
            MagicMock(stdout="/home/testuser/summitflow\n"),
            MagicMock(stdout="/home/testuser/agent-hub\n"),
            MagicMock(stdout="/home/testuser/research\n"),
            MagicMock(stdout="/home/testuser/a-term\n"),
            MagicMock(stdout="/home/testuser/antigravity\n"),
        ]
        sessions = list_external_agent_tmux_sessions()

    assert [session["id"] for session in sessions] == [
        "agy-antigravity",
        "claude-summitflow",
        "codex-agent-hub",
        "hermes-research",
        "pi-a-term",
    ]
    by_id = {str(session["id"]): session for session in sessions}
    assert by_id["claude-summitflow"]["project_id"] == "summitflow"
    assert by_id["claude-summitflow"]["mode"] == "claude"
    assert by_id["codex-agent-hub"]["project_id"] == "agent-hub"
    assert by_id["codex-agent-hub"]["mode"] == "codex"
    assert by_id["hermes-research"]["project_id"] == "research"
    assert by_id["hermes-research"]["mode"] == "hermes"
    assert by_id["pi-a-term"]["project_id"] == "a-term"
    assert by_id["pi-a-term"]["mode"] == "pi"
    assert by_id["agy-antigravity"]["project_id"] == "antigravity"
    assert by_id["agy-antigravity"]["mode"] == "agy"


def test_list_external_agent_tmux_sessions_discovers_aico_socket_sessions() -> None:
    def fake_run_tmux_command(args, check=False, socket_name=None):
        if args[:2] != ["list-panes", "-a"]:
            return False, "unexpected"
        if socket_name == "aico":
            return (
                True,
                "\n".join(
                    [
                        "aico-7\t%1\t/home/testuser/aico\tbash",
                        "aico-8\t%2\t/home/testuser/agent-hub\tcodex",
                        "other\t%3\t/home/testuser/other\tcodex",
                    ]
                ),
            )
        return True, "codex-default\t%4\t/home/testuser/default\tcodex"

    with (
        patch("a_term.utils.tmux.run_tmux_command", side_effect=fake_run_tmux_command),
        patch("a_term.utils.tmux.external._catalogued_aico_tmux_sources", return_value=()),
        patch("a_term.utils.tmux.subprocess.run") as mock_subprocess,
    ):
        mock_subprocess.side_effect = [
            MagicMock(stdout="/home/testuser/default\n"),
            MagicMock(stdout="/home/testuser/aico\n"),
            MagicMock(stdout="/home/testuser/agent-hub\n"),
        ]
        sessions = list_external_agent_tmux_sessions()

    assert [session["id"] for session in sessions] == [
        "tmux:aico:aico-7",
        "tmux:aico:aico-8",
        "codex-default",
    ]
    assert sessions[0]["mode"] == "shell"
    assert sessions[0]["tmux_socket"] == "aico"
    assert sessions[0]["tmux_source"] == "aico"
    assert sessions[1]["mode"] == "codex"
    assert sessions[2]["tmux_socket"] is None


def test_external_mode_inference_requires_token_boundaries() -> None:
    assert tmux._infer_external_mode("pi-a-term", "node") == ("pi", "running")
    assert tmux._infer_external_mode("antigravity", "agy") == ("agy", "running")
    assert tmux._infer_external_mode("api-service", "python") == ("shell", "not_started")


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


def test_get_scrollback_with_cursor_suppresses_missing_target_warning() -> None:
    with (
        patch(
            "a_term.utils.tmux.run_tmux_command",
            return_value=(False, "can't find pane: summitflow-missing"),
        ),
        patch("a_term.utils.tmux.scrollback.logger.warning") as mock_warning,
        patch("a_term.utils.tmux.scrollback.logger.debug") as mock_debug,
    ):
        assert get_scrollback_with_cursor("summitflow-missing") == (None, None)

    mock_warning.assert_not_called()
    mock_debug.assert_called_once_with(
        "tmux_scrollback_with_cursor_failed",
        session="summitflow-missing",
        error="can't find pane: summitflow-missing",
    )


def test_get_scrollback_with_cursor_warns_on_generic_failure() -> None:
    with (
        patch(
            "a_term.utils.tmux.run_tmux_command",
            return_value=(False, "permission denied"),
        ),
        patch("a_term.utils.tmux.scrollback.logger.warning") as mock_warning,
        patch("a_term.utils.tmux.scrollback.logger.debug") as mock_debug,
    ):
        assert get_scrollback_with_cursor("summitflow-problem") == (None, None)

    mock_debug.assert_not_called()
    mock_warning.assert_called_once_with(
        "tmux_scrollback_with_cursor_failed",
        session="summitflow-problem",
        error="permission denied",
    )


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


def test_apply_external_attach_options_targets_named_socket() -> None:
    with patch(
        "a_term.utils.tmux.run_tmux_command",
        side_effect=[
            (True, "on"),
            (True, "off"),
            (True, ""),
            (True, ""),
        ],
    ) as mock_run:
        assert apply_external_attach_options("aico-7", "aico") is True
        assert restore_external_attach_options("aico-7", "aico") is True

    assert mock_run.call_args_list == [
        call(["show-options", "-qv", "-t", "aico-7", "status"], socket_name="aico"),
        call(["show-options", "-qv", "-t", "aico-7", "mouse"], socket_name="aico"),
        call(["set-option", "-t", "aico-7", "status", "off"], socket_name="aico"),
        call(["set-option", "-t", "aico-7", "status", "on"], socket_name="aico"),
    ]
