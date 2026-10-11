"""Session broker behind tsession/tclaude/tcodex."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from a_term.services import lifecycle
from a_term.services.session_broker import ensure_project_tool_session, list_project_tool_sessions
from a_term.storage import panes as pane_store
from a_term.storage import project_settings

from .fake_tether import FakeTether


@pytest.fixture()
def tether(fake_tether: FakeTether, no_default_tmux: MagicMock) -> FakeTether:
    return fake_tether


def test_creates_pane_and_session_when_none_exists(tether: FakeTether, tmp_path) -> None:
    target = ensure_project_tool_session("proj", "claude", working_dir=str(tmp_path))
    assert target.created is True and target.started is False
    assert target.mode == "claude-code"  # alias canonicalized
    assert target.attach_argv[1:4] == ["-S", target.tmux_socket, "attach-session"]
    assert target.attach_env["TERM"] == "xterm-256color"
    pane = pane_store.get_pane(target.pane_id)
    assert pane is not None and pane["project_id"] == "proj"
    modes = sorted(link["mode"] for link in pane_store.links_for_pane(pane["id"]))
    assert modes == ["claude-code", "shell"]
    settings = project_settings.get_settings("proj")
    assert settings is not None and settings["enabled"] and settings["active_mode"] == "claude-code"
    created = [body for method, path, body in tether.calls if (method, path) == ("POST", "/v1/sessions")]
    assert {body["origin"] for body in created} == {"a-term"}


def test_reuses_existing_session_instead_of_creating(tether: FakeTether, tmp_path) -> None:
    first = ensure_project_tool_session("proj", "codex", working_dir=str(tmp_path))
    creates = sum(1 for m, p, _ in tether.calls if (m, p) == ("POST", "/v1/sessions"))
    second = ensure_project_tool_session("proj", "codex", working_dir=str(tmp_path))
    assert second.session_id == first.session_id and second.created is False
    assert sum(1 for m, p, _ in tether.calls if (m, p) == ("POST", "/v1/sessions")) == creates


def test_reused_aico_session_gets_a_detached_view(tether: FakeTether, tmp_path) -> None:
    aico = tether.add_session(tool="codex", project_id="proj", project_root=str(tmp_path), origin="aico")
    target = ensure_project_tool_session("proj", "codex", working_dir=str(tmp_path))
    assert target.session_id == aico["id"] and target.created is False
    pane = pane_store.get_pane(target.pane_id)
    assert pane is not None and pane["is_detached"] is True


def test_working_dir_must_match_to_reuse(tether: FakeTether, tmp_path) -> None:
    other = tmp_path / "other"
    other.mkdir()
    tether.add_session(tool="codex", project_id="proj", project_root=str(other))
    target = ensure_project_tool_session("proj", "codex", working_dir=str(tmp_path))
    assert target.created is True


def test_not_running_agent_is_respawned(tether: FakeTether, tmp_path) -> None:
    tether.add_session(tool="codex", project_id="proj", project_root=str(tmp_path), status="uncertain")
    target = ensure_project_tool_session("proj", "codex", working_dir=str(tmp_path))
    assert target.created is False and target.started is True


def test_list_filters_shell_projectless_and_tool(tether: FakeTether) -> None:
    lifecycle.create_pane_with_sessions(pane_type="project", pane_name="P", project_id="b", agent_tool_slug="claude")
    tether.add_session(tool="codex", project_id="a")
    tether.add_session(tool="codex", project_id=None)
    tether.add_session(tool="shell", project_id="a")

    targets = list_project_tool_sessions()
    assert [(t.project_id, t.mode) for t in targets] == [("a", "codex"), ("b", "claude-code")]
    assert [t.project_id for t in list_project_tool_sessions("claude")] == ["b"]
    linked = list_project_tool_sessions("claude-code")[0]
    assert linked.pane_name == "P" and linked.attach_argv == []
