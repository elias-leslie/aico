"""tsession: open/list/projects and attaching across tmux servers."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
import structlog

from a_term.cli import session_broker as cli
from a_term.services.session_broker import BrokerSessionTarget

from .fake_tether import FakeTether

SOCKET = "/tmp/tether-test/tmux-a0000001.sock"


def _target(**overrides: object) -> BrokerSessionTarget:
    values: dict = {
        "project_id": "a-term",
        "mode": "codex",
        "pane_id": "pane-1",
        "pane_name": "A-Term",
        "session_id": "a0000001",
        "tmux_session_name": "tether-a0000001",
        "tmux_socket": SOCKET,
        "working_dir": "/srv/a-term",
        "created": False,
        "started": False,
        "attach_argv": ["/usr/bin/tmux", "-S", SOCKET, "attach-session", "-t", "$1"],
        "attach_env": {"TERM": "xterm-256color"},
    }
    values.update(overrides)
    return BrokerSessionTarget(**values)



@pytest.fixture(autouse=True)
def _restore_logging():
    """The CLIs point structlog at the (captured) stderr; undo that per test."""
    yield
    structlog.reset_defaults()

# --- attach planning across tmux servers -----------------------------------


def test_outside_tmux_runs_tethers_attach_argv() -> None:
    kind, argv, env = cli.attach_plan(_target(), environ={"HOME": "/h"})
    assert kind == "attach"
    assert argv == ["/usr/bin/tmux", "-S", SOCKET, "attach-session", "-t", "$1"]
    assert env["TERM"] == "xterm-256color" and "TMUX" not in env


def test_inside_the_same_server_switches_client() -> None:
    kind, argv, _ = cli.attach_plan(_target(), environ={"TMUX": f"{SOCKET},1234,0", "TMUX_PANE": "%1"})
    assert kind == "switch"
    assert argv == ["/usr/bin/tmux", "-S", SOCKET, "switch-client", "-t", "$1"]


def test_inside_a_different_server_attaches_nested_without_tmux_env() -> None:
    environ = {"TMUX": "/tmp/tmux-1000/default,999,3", "TMUX_PANE": "%9", "HOME": "/h"}
    kind, argv, env = cli.attach_plan(_target(), environ=environ)
    assert kind == "nested"
    assert argv[3] == "attach-session"  # never a cross-server switch-client
    assert "TMUX" not in env and "TMUX_PANE" not in env
    assert environ["TMUX"]  # the caller's environment is untouched


def test_missing_attach_target_is_an_error() -> None:
    with pytest.raises(ValueError):
        cli.attach_plan(_target(attach_argv=[]), environ={})


def test_print_shows_nested_command(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setenv("TMUX", "/tmp/tmux-1000/default,999,3")
    with patch("a_term.cli.session_broker.subprocess.run") as run:
        assert cli._attach(_target(), print_only=True) == 0
    run.assert_not_called()
    out = capsys.readouterr().out.strip()
    assert out.startswith("env -u TMUX -u TMUX_PANE /usr/bin/tmux -S ")
    assert out.endswith("attach-session -t '$1'")


def test_nested_attach_prints_notice_to_stderr(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setenv("TMUX", "/tmp/tmux-1000/default,999,3")
    with patch("a_term.cli.session_broker.subprocess.run", return_value=MagicMock(returncode=0)) as run:
        assert cli._attach(_target(), print_only=False) == 0
    captured = capsys.readouterr()
    assert "different tmux server" in captured.err and captured.out == ""
    assert "TMUX" not in run.call_args.kwargs["env"]


def test_same_server_attach_has_no_notice(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setenv("TMUX", f"{SOCKET},1,0")
    with patch("a_term.cli.session_broker.subprocess.run", return_value=MagicMock(returncode=0)) as run:
        cli._attach(_target(), print_only=False)
    assert run.call_args.args[0][3] == "switch-client"
    assert capsys.readouterr().err == ""


# --- commands ----------------------------------------------------------------


def test_open_prints_json_target(capsys: pytest.CaptureFixture[str]) -> None:
    with patch("a_term.cli.session_broker.ensure_project_tool_session", return_value=_target()) as ensure:
        assert cli.main(["open", "--tool", "codex", "--project", "a-term", "--cwd", "/srv/a-term"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["session_id"] == "a0000001" and payload["tmux_socket"] == SOCKET
    ensure.assert_called_once_with(project_id="a-term", tool_slug="codex", working_dir="/srv/a-term")


def test_open_attach_uses_attach_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TMUX", raising=False)
    with (
        patch("a_term.cli.session_broker.ensure_project_tool_session", return_value=_target()),
        patch("a_term.cli.session_broker.subprocess.run", return_value=MagicMock(returncode=3)) as run,
    ):
        assert cli.main(["open", "--tool", "codex", "--project", "a-term", "--attach"]) == 3
    assert run.call_args.args[0][3] == "attach-session"


def test_list_project_id_deduplicates(capsys: pytest.CaptureFixture[str]) -> None:
    targets = [_target(), _target(session_id="a0000002"), _target(project_id="other")]
    with patch("a_term.cli.session_broker.list_project_tool_sessions", return_value=targets):
        assert cli.main(["list", "--tool", "codex", "--format", "project-id"]) == 0
    assert capsys.readouterr().out.split() == ["a-term", "other"]


def test_list_table_and_empty(capsys: pytest.CaptureFixture[str]) -> None:
    with patch("a_term.cli.session_broker.list_project_tool_sessions", return_value=[]):
        cli.main(["list"])
    assert "No running project sessions." in capsys.readouterr().out
    with patch("a_term.cli.session_broker.list_project_tool_sessions", return_value=[_target(pane_name=None)]):
        cli.main(["list"])
    assert capsys.readouterr().out.strip() == "a-term\tcodex\ta0000001\t-"


def test_projects_tsv(fake_tether: FakeTether, capsys: pytest.CaptureFixture[str]) -> None:
    fake_tether.state.projects = [
        {"id": "a-term", "name": "A-Term", "root": "/srv/a-term", "lifecycle": None},
        {"id": "bad", "name": "Bad", "root": "/srv/with\ttab", "lifecycle": None},
    ]
    assert cli.main(["projects", "--format", "tsv"]) == 0
    assert capsys.readouterr().out == "a-term\t/srv/a-term\n"


def test_projects_prints_nothing_when_tether_is_down(tether_down: str, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["projects"]) == 0
    assert capsys.readouterr().out == ""


def test_open_reports_tether_down(tether_down: str, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["open", "--tool", "codex", "--project", "x"]) == 69
    assert "Tether is not reachable" in capsys.readouterr().err
