"""Closing a session from A-Term: Tether End plus pane bookkeeping."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from a_term.services import lifecycle
from a_term.services.session_close import close_session
from a_term.storage import panes as pane_store

from .fake_tether import FakeTether

LEGACY_ID = "70b339cd-93a0-4898-8c4b-3d694ce8e8dc"


@pytest.fixture()
def tether(fake_tether: FakeTether, no_default_tmux: MagicMock) -> FakeTether:
    return fake_tether


def _project_pane() -> tuple[dict, dict, dict]:
    pane = lifecycle.create_pane_with_sessions(pane_type="project", pane_name="P", project_id="proj")
    shell, agent = pane["sessions"]
    return pane, shell, agent


def test_closing_agent_ends_shell_companion_and_deletes_pane(tether: FakeTether) -> None:
    pane, _shell, agent = _project_pane()
    result = close_session(agent["id"])
    assert result == {
        "deleted": True,
        "id": agent["id"],
        "next_session_id": None,
        "pane_id": pane["id"],
        "pane_deleted": True,
        "is_external": False,
    }
    assert pane_store.get_pane(pane["id"]) is None
    assert tether.state.sessions == {}


def test_closing_shell_keeps_agent_and_promotes_it(tether: FakeTether) -> None:
    pane, shell, agent = _project_pane()
    pane_store.update_pane(pane["id"], active_mode="shell")
    result = close_session(shell["id"])
    assert result["pane_deleted"] is False
    assert result["next_session_id"] == agent["id"]
    assert pane_store.get_pane(pane["id"])["active_mode"] == "codex"  # type: ignore[index]
    assert agent["id"] in tether.state.sessions and shell["id"] not in tether.state.sessions


def test_closing_in_detached_pane_returns_no_next_session(tether: FakeTether) -> None:
    pane, shell, _agent = _project_pane()
    pane_store.detach_pane(pane["id"])
    assert close_session(shell["id"])["next_session_id"] is None


def test_closing_last_session_deletes_adhoc_pane(tether: FakeTether) -> None:
    pane = lifecycle.create_pane_with_sessions(pane_type="adhoc", pane_name="Scratch")
    result = close_session(pane["sessions"][0]["id"])
    assert result["pane_deleted"] is True


def test_external_session_is_never_ended(tether: FakeTether) -> None:
    with patch("a_term.services.session_close.lifecycle.end_session") as end:
        result = close_session("my-own-tmux")
    end.assert_not_called()
    assert result["is_external"] is True


def test_unlinked_tether_session_is_ended_and_reported_external(tether: FakeTether) -> None:
    session = tether.add_session(origin="aico")
    result = close_session(session["id"])
    assert result["is_external"] is True
    assert session["id"] not in tether.state.sessions


def test_legacy_session_is_killed_exactly(tether: FakeTether) -> None:
    pane = pane_store.create_pane(pane_type="adhoc", pane_name="Old")
    pane_store.link_session(LEGACY_ID, pane["id"], "shell", kind="legacy")
    with patch("a_term.utils.tmux.kill_legacy_session", return_value=True) as kill:
        result = close_session(LEGACY_ID)
    kill.assert_called_once_with(LEGACY_ID)
    assert result["pane_deleted"] is True
