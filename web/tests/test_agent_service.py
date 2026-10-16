"""Starting an agent is an explicit Tether respawn, never automatic."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from a_term.services import agent_service, lifecycle
from a_term.services.session_catalog import Session
from a_term.storage import panes as pane_store

from . import session_factory as make
from .fake_tether import FakeTether


@pytest.fixture()
def tether(fake_tether: FakeTether, no_default_tmux: MagicMock) -> FakeTether:
    return fake_tether


def _session(tether: FakeTether, mode: str = "codex", status: str = "running") -> Session:
    tether.state.next_create_status = status
    pane = pane_store.create_pane(pane_type="project", pane_name="P", project_id="proj")
    return lifecycle.create_session(pane_id=pane["id"], mode=mode)


def test_running_agent_is_left_alone(tether: FakeTether) -> None:
    session = _session(tether)
    result = agent_service.start_agent(session["id"])
    assert result == agent_service.StartResult(False, "running", "Agent is already running")
    assert not any(path.endswith("/respawn") for _, path, _ in tether.calls)


def test_pending_agent_is_reported_starting(tether: FakeTether) -> None:
    session = _session(tether, status="pending")
    assert agent_service.start_agent(session["id"]).state == "starting"


def test_uncertain_agent_is_respawned(tether: FakeTether) -> None:
    session = _session(tether, status="uncertain")
    result = agent_service.start_agent(session["id"])
    assert result.started is True and result.state == "running"
    assert any(path.endswith("/respawn") for _, path, _ in tether.calls)


def test_shell_unknown_and_legacy_are_refused(tether: FakeTether) -> None:
    shell = _session(tether, mode="shell")
    with pytest.raises(lifecycle.LifecycleError) as caught:
        agent_service.start_agent(shell["id"])
    assert (caught.value.status_code, caught.value.detail) == (400, "Session is in shell mode, not agent mode")
    with pytest.raises(lifecycle.LifecycleError) as caught:
        agent_service.start_agent("bbbbbbbb")
    assert caught.value.status_code == 404
    with (
        patch("a_term.services.agent_service.session_catalog.get_session", return_value=make.legacy()),
        pytest.raises(lifecycle.LifecycleError) as caught,
    ):
        agent_service.start_agent(make.LEGACY_ID)
    assert (caught.value.status_code, caught.value.detail) == (409, "This session predates Tether and is attach-only")


def test_root_and_external_sessions_are_not_started(tether: FakeTether) -> None:
    cases = [
        (make.own_tmux(), "External tmux agent session is already running", "running"),
        (make.tether(rootRequestId="req-1", status="uncertain"), "Root launch is owned by its retained request", "error"),
    ]
    for session, message, state in cases:
        with patch("a_term.services.agent_service.session_catalog.get_session", return_value=session):
            assert agent_service.start_agent("x") == agent_service.StartResult(False, state, message)
    assert not any(path.endswith("/respawn") for _, path, _ in tether.calls)


def test_normalize_state() -> None:
    assert agent_service.normalize_state("running") == "running"
    assert agent_service.normalize_state("weird") == "not_started"
