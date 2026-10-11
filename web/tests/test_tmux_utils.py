"""Tests for tmux utility functions."""

from __future__ import annotations

from unittest.mock import MagicMock, call, patch

import pytest

from a_term.utils import tmux
from a_term.utils.tmux import (
    TMUX_SESSION_PREFIX,
    apply_external_attach_options,
    build_tmux_command,
    get_cursor_position,
    get_external_agent_tmux_session,
    get_scrollback_with_cursor,
    get_tmux_session_name,
    is_managed_tmux_session_name,
    kill_legacy_session,
    list_external_agent_tmux_sessions,
    list_tmux_sessions,
    reset_tmux_window_size_policy,
    restore_external_attach_options,
    validate_session_name,
    validate_socket_name,
)
from a_term.utils.tmux import external as external_tmux


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
                        "claude-summitflow\t%1\t/home/testuser/summitflow\tclaude\t0",
                        "summitflow-123e4567-e89b-12d3-a456-426614174000\t%2\t/home/testuser/summitflow\tbash\t0",
                        "codex-agent-hub\t%3\t/home/testuser/agent-hub\tcodex\t0",
                        "pi-research\t%4\t/home/testuser/research\tpi\t0",
                        "pi-a-term\t%5\t/home/testuser/a-term\tpi\t0",
                        "agy-antigravity\t%6\t/home/testuser/antigravity\tagy\t0",
                    ]
                ),
            ),
        ),
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
        "pi-a-term",
        "pi-research",
    ]
    by_id = {str(session["id"]): session for session in sessions}
    assert by_id["claude-summitflow"]["project_id"] == "summitflow"
    assert by_id["claude-summitflow"]["mode"] == "claude"
    assert by_id["codex-agent-hub"]["project_id"] == "agent-hub"
    assert by_id["codex-agent-hub"]["mode"] == "codex"
    assert by_id["pi-research"]["project_id"] == "research"
    assert by_id["pi-research"]["mode"] == "pi"
    assert by_id["pi-a-term"]["project_id"] == "a-term"
    assert by_id["pi-a-term"]["mode"] == "pi"
    assert by_id["agy-antigravity"]["project_id"] == "antigravity"
    assert by_id["agy-antigravity"]["mode"] == "agy"


def test_external_discovery_reads_only_the_default_server() -> None:
    seen_sockets: list[str | None] = []

    def fake_run_tmux_command(args, check=False, socket_name=None):
        seen_sockets.append(socket_name)
        return True, "codex-default\t%4\t/home/testuser/default\tcodex\t0"

    with (
        patch("a_term.utils.tmux.run_tmux_command", side_effect=fake_run_tmux_command),
        patch("a_term.utils.tmux.subprocess.run", return_value=MagicMock(stdout="/home/testuser/default\n")),
    ):
        sessions = list_external_agent_tmux_sessions()

    assert seen_sockets == [None]
    assert [session["id"] for session in sessions] == ["codex-default"]
    assert sessions[0]["tmux_socket"] is None
    assert sessions[0]["tmux_source"] == "default"
    assert not hasattr(external_tmux, "_catalogued_aico_tmux_sources")
    assert [source.id for source in external_tmux._external_tmux_sources()] == ["default"]


def test_external_mode_inference_requires_token_boundaries() -> None:
    assert tmux._infer_external_mode("pi-a-term", "node") == ("pi", "running")
    assert tmux._infer_external_mode("antigravity", "agy") == ("agy", "running")
    assert tmux._infer_external_mode("api-service", "python") == ("shell", "not_started")


class TestKillLegacySession:
    def test_uses_exact_session_target(self) -> None:
        session_id = "123e4567-e89b-12d3-a456-426614174000"
        with patch("a_term.utils.tmux.run_tmux_command", return_value=(True, "")) as mock_run:
            assert kill_legacy_session(session_id) is True
        mock_run.assert_called_once_with(["kill-session", "-t", f"=summitflow-{session_id}"])

    def test_already_gone_is_not_an_error(self) -> None:
        with patch("a_term.utils.tmux.run_tmux_command", return_value=(False, "can't find session: x")):
            assert kill_legacy_session("123e4567-e89b-12d3-a456-426614174000") is False

    def test_other_failures_raise(self) -> None:
        with (
            patch("a_term.utils.tmux.run_tmux_command", return_value=(False, "permission denied")),
            pytest.raises(tmux.TmuxError),
        ):
            kill_legacy_session("123e4567-e89b-12d3-a456-426614174000")


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


def test_infer_external_mode_finds_agent_below_a_shell_pane() -> None:
    """An agent started from a shell shares its process group.

    tmux then reports the shell as ``pane_current_command``, so the pane has to
    be classified from its process tree or the agent looks like a shell.
    """
    with patch(
        "a_term.utils.tmux.external._pane_descendant_labels",
        return_value=["claude-real claude-real"],
    ):
        assert external_tmux._infer_external_mode("agent-e03c60b0", "bash", "4242") == (
            "claude",
            "running",
        )


def test_infer_external_mode_keeps_plain_shell_panes_as_shells() -> None:
    with patch(
        "a_term.utils.tmux.external._pane_descendant_labels",
        return_value=["git git", "less less"],
    ):
        assert external_tmux._infer_external_mode("scratch-bfa0cfb0", "bash", "4242") == (
            "shell",
            "not_started",
        )


def test_infer_external_mode_skips_process_scan_for_non_shell_panes() -> None:
    with patch(
        "a_term.utils.tmux.external._pane_descendant_labels",
        side_effect=AssertionError("must not scan"),
    ):
        assert external_tmux._infer_external_mode("scratch", "vim", "4242") == (
            "shell",
            "not_started",
        )
