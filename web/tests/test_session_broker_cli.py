"""Tests for the shared Terminal session broker CLI."""

from __future__ import annotations

import json
from io import StringIO
from unittest.mock import patch

from terminal.cli.session_broker import main
from terminal.services.session_broker import BrokerSessionTarget

TERMINAL_ROOT = "/workspace/projects/terminal"


def _make_target() -> BrokerSessionTarget:
    return BrokerSessionTarget(
        project_id="terminal",
        mode="codex",
        pane_id="pane-1",
        pane_name="Terminal",
        session_id="session-1",
        tmux_session_name="summitflow-session-1",
        working_dir=TERMINAL_ROOT,
        created=False,
        started=False,
    )


def test_open_command_prints_json_target() -> None:
    stdout = StringIO()
    with (
        patch("terminal.cli.session_broker.ensure_project_tool_session", return_value=_make_target()) as ensure_mock,
        patch("sys.stdout", stdout),
    ):
        exit_code = main(["open", "--tool", "codex", "--project", "terminal", "--cwd", TERMINAL_ROOT])

    assert exit_code == 0
    payload = json.loads(stdout.getvalue())
    assert payload["project_id"] == "terminal"
    assert payload["mode"] == "codex"
    ensure_mock.assert_called_once_with(
        project_id="terminal",
        tool_slug="codex",
        working_dir=TERMINAL_ROOT,
    )


def test_list_command_project_id_format_deduplicates_projects() -> None:
    stdout = StringIO()
    with (
        patch(
            "terminal.cli.session_broker.list_project_tool_sessions",
            return_value=[
                _make_target(),
                BrokerSessionTarget(
                    project_id="terminal",
                    mode="codex",
                    pane_id="pane-2",
                    pane_name="Terminal [2]",
                    session_id="session-2",
                    tmux_session_name="summitflow-session-2",
                    working_dir=TERMINAL_ROOT,
                    created=False,
                    started=False,
                ),
            ],
        ),
        patch("sys.stdout", stdout),
    ):
        exit_code = main(["list", "--tool", "codex", "--format", "project-id"])

    assert exit_code == 0
    assert stdout.getvalue().strip() == "terminal"
