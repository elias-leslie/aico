"""Starting an agent is an explicit Tether respawn, never automatic."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from a_term.services import agent_service, lifecycle
from a_term.storage import panes as pane_store

from .fake_tether import FakeTether


@pytest.fixture()
def tether(fake_tether: FakeTether, no_default_tmux: MagicMock) -> FakeTether:
    return fake_tether


def _session(tether: FakeTether, mode: str = "codex", status: str = "running") -> dict:
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
    assert caught.value.status_code == 400
    with pytest.raises(lifecycle.LifecycleError) as caught:
        agent_service.start_agent("bbbbbbbb")
    assert caught.value.status_code == 404
    legacy = {"mode": "codex", "is_legacy": True, "agent_state": "running", "source": "legacy"}
    with (
        patch("a_term.services.agent_service.session_catalog.get_session", return_value=legacy),
        pytest.raises(lifecycle.LifecycleError) as caught,
    ):
        agent_service.start_agent("70b339cd-93a0-4898-8c4b-3d694ce8e8dc")
    assert caught.value.status_code == 409


def test_root_and_external_sessions_are_not_started(tether: FakeTether) -> None:
    for session in ({"source": "tmux_external", "agent_state": "running"}, {"is_root": True, "source": "tether"}):
        with patch("a_term.services.agent_service.session_catalog.get_session", return_value=session):
            assert agent_service.start_agent("x").started is False


def test_normalize_state() -> None:
    assert agent_service.normalize_state("running") == "running"
    assert agent_service.normalize_state("weird") == "not_started"
