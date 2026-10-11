"""Resolving a session into the attach plan a WebSocket view runs."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from a_term.api.handlers.session_validation import validate_and_prepare_session
from a_term.services.pty_manager import attach_environment
from a_term.storage import panes as pane_store

from .fake_tether import TMUX_BIN, FakeTether

LEGACY_ID = "123e4567-e89b-12d3-a456-426614174000"


def _legacy_tmux(args, check=False, socket_name=None):
    assert socket_name is None
    if args[:2] == ["list-panes", "-a"]:
        return True, f"summitflow-{LEGACY_ID}\t$1\t%1\t/home/u/proj\tbash\t42"
    return False, "unexpected"


def test_tether_session_attaches_with_tethers_exact_argv(fake_tether: FakeTether) -> None:
    session = fake_tether.add_session(tool="codex", project_id="p", origin="a-term")
    pane = pane_store.create_pane(pane_type="project", pane_name="P", project_id="p")
    pane_store.link_session(session["id"], pane["id"], "codex")

    plan = validate_and_prepare_session(session["id"])

    socket_path = session["tmux"]["socket"]
    assert plan.kind == "tether"
    assert plan.argv == [TMUX_BIN, "-S", socket_path, "attach-session", "-t", session["tmux"]["sessionId"]]
    assert plan.tmux_socket == socket_path
    assert plan.tmux_session_name == session["tmux"]["sessionName"]
    assert plan.generation == session["generation"]
    assert plan.env["COLORTERM"] == "truecolor"
    assert plan.unset == ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NO_COLOR"]
    assert plan.session["pane_id"] == pane["id"]
    assert pane_store.get_link(session["id"])["last_accessed_at"]  # type: ignore[index]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda argv: argv.__setitem__(0, "tmux"),  # not absolute
        lambda argv: argv.__setitem__(0, "/bin/sh"),  # not tmux
        lambda argv: argv.__setitem__(1, "-L"),  # named socket
        lambda argv: argv.__setitem__(2, "/tmp/other.sock"),  # another server
        lambda argv: argv.__setitem__(3, "kill-server"),
        lambda argv: argv.__setitem__(5, "$1; rm -rf /"),
        lambda argv: argv.append("-d"),
    ],
)
def test_unexpected_attach_argv_is_refused(fake_tether: FakeTether, mutate) -> None:
    session = fake_tether.add_session()
    good = [TMUX_BIN, "-S", session["tmux"]["socket"], "attach-session", "-t", session["tmux"]["sessionId"]]
    bad = list(good)
    mutate(bad)
    with (
        patch(
            "a_term.tether.client.TetherClient.attach_target",
            return_value={"generation": session["generation"], "argv": bad, "env": {}},
        ),
        pytest.raises(ValueError, match="unexpected attach target"),
    ):
        validate_and_prepare_session(session["id"])


def test_ended_tether_session_is_reported_not_recreated(fake_tether: FakeTether) -> None:
    with pytest.raises(ValueError, match="Session not found"):
        validate_and_prepare_session("deadbeef")
    assert all(method == "GET" for method, _path, _body in fake_tether.calls)


def test_tether_down_is_a_clear_error(tether_down: str) -> None:
    with pytest.raises(ValueError, match="Tether is not reachable"):
        validate_and_prepare_session("deadbeef")


def test_legacy_session_attaches_on_the_default_server(fake_tether: FakeTether) -> None:
    pane = pane_store.create_pane(pane_type="adhoc", pane_name="Old")
    pane_store.link_session(LEGACY_ID, pane["id"], "shell", kind="legacy")
    with patch("a_term.utils.tmux.run_tmux_command", side_effect=_legacy_tmux):
        plan = validate_and_prepare_session(LEGACY_ID)

    assert plan.kind == "legacy"
    assert plan.tmux_socket is None
    assert plan.argv == ["tmux", "attach-session", "-t", f"summitflow-{LEGACY_ID}"]
    assert plan.generation is None


def test_users_own_session_attaches_on_the_default_server(fake_tether: FakeTether) -> None:
    external = {"id": "claude-work", "tmux_session_name": "claude-work", "is_external": True, "mode": "claude"}
    with patch("a_term.utils.tmux.get_external_agent_tmux_session", return_value=external):
        plan = validate_and_prepare_session("claude-work")

    assert plan.kind == "external"
    assert plan.tmux_socket is None
    assert plan.argv == ["tmux", "attach-session", "-t", "claude-work"]


def test_missing_legacy_session_is_reported(fake_tether: FakeTether, no_default_tmux) -> None:
    with pytest.raises(ValueError, match="Session not found"):
        validate_and_prepare_session(LEGACY_ID)


def test_attach_environment_drops_tmux_markers_and_applies_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TMUX", "/tmp/tmux-1000/default,1,0")
    monkeypatch.setenv("TMUX_PANE", "%3")
    monkeypatch.setenv("NO_COLOR", "1")
    env = attach_environment({"COLORTERM": "truecolor", "TMUX": "/sneaky,1,0", "TERM": "tmux-256color"})
    assert "TMUX" not in env
    assert "TMUX_PANE" not in env
    assert "NO_COLOR" not in env
    assert env["COLORTERM"] == "truecolor"
    assert env["TERM"] == "tmux-256color"


def test_attach_environment_removes_tethers_unset_list(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TMUX_TMPDIR", "/tmp/x")
    monkeypatch.setenv("SOMETHING_NEW", "1")
    monkeypatch.setenv("KEEP", "yes")
    env = attach_environment({"CLICOLOR": "1"}, ["TMUX_TMPDIR", "SOMETHING_NEW"])
    assert "TMUX_TMPDIR" not in env and "SOMETHING_NEW" not in env
    assert env["CLICOLOR"] == "1" and env["KEEP"] == "yes"


def test_attach_environment_defaults_term(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TERM", raising=False)
    assert attach_environment()["TERM"] == "xterm-256color"
