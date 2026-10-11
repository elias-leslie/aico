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
    }
    values.update(overrides)
    return BrokerSessionTarget(**values)



@pytest.fixture(autouse=True)
def _restore_logging():
    """The CLIs point structlog at the (captured) stderr; undo that per test."""
    yield
    structlog.reset_defaults()

# --- attaching is Tether's -----------------------------------------------------


def test_attach_delegates_to_tether_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TETHER_BIN", "/opt/tether")
    assert cli.tether_attach_argv("a0000001") == ["/opt/tether", "sessions", "attach", "a0000001"]
    assert cli.tether_attach_argv("a0000001", print_only=True)[-1] == "--print"


def test_attach_without_tether_cli_is_an_error(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv("TETHER_BIN", raising=False)
    monkeypatch.setenv("PATH", "/nonexistent")
    with patch("a_term.cli.session_broker.ensure_project_tool_session", return_value=_target()):
        assert cli.main(["open", "--tool", "codex", "--project", "a-term", "--attach"]) == 69
    assert "tether CLI" in capsys.readouterr().err


# --- commands ----------------------------------------------------------------


def test_open_prints_json_target(capsys: pytest.CaptureFixture[str]) -> None:
    with patch("a_term.cli.session_broker.ensure_project_tool_session", return_value=_target()) as ensure:
        assert cli.main(["open", "--tool", "codex", "--project", "a-term", "--cwd", "/srv/a-term"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["session_id"] == "a0000001" and payload["tmux_socket"] == SOCKET
    ensure.assert_called_once_with(project_id="a-term", tool_slug="codex", working_dir="/srv/a-term")


def test_open_attach_runs_tether_sessions_attach(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TETHER_BIN", "/opt/tether")
    with (
        patch("a_term.cli.session_broker.ensure_project_tool_session", return_value=_target()),
        patch("a_term.cli.session_broker.subprocess.run", return_value=MagicMock(returncode=3)) as run,
    ):
        assert cli.main(["open", "--tool", "codex", "--project", "a-term", "--attach", "--print"]) == 3
    assert run.call_args.args[0] == ["/opt/tether", "sessions", "attach", "a0000001", "--print"]


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
