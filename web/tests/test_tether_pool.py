"""Two Tether instances (the owner's and the agent's) behind one client."""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

from a_term.services import lifecycle, session_catalog
from a_term.services.tether_events import TetherEventWatcher
from a_term.storage import panes as pane_store
from a_term.tether import TetherError, TetherPool, TetherUnavailable, get_client, set_client

from .fake_tether import FakeTether


@pytest.fixture()
def two(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[FakeTether, FakeTether]]:
    """(owner, agent) fakes; with TETHER_SOCKET unset the owner's instance is active."""
    base = Path(tempfile.mkdtemp(prefix="at-pool-", dir="/tmp"))
    runtime = base / "run"
    (runtime / "tether" / "default").mkdir(parents=True)
    (base / "agent").mkdir()
    owner = FakeTether(runtime / "tether" / "default")
    owner.start()
    agent = FakeTether(base / "agent")
    agent.state._counter = 100  # distinct session ids
    agent.start()
    monkeypatch.delenv("TETHER_SOCKET", raising=False)
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(runtime))
    monkeypatch.setenv("TETHER_AGENT_SOCKET", agent.socket_path)
    monkeypatch.setenv("XDG_STATE_HOME", str(base))
    set_client(None)
    try:
        yield owner, agent
    finally:
        set_client(None)
        owner.stop()
        agent.stop()
        shutil.rmtree(base, ignore_errors=True)


def test_list_merges_both_and_active_gets_new_sessions(two: tuple[FakeTether, FakeTether]) -> None:
    owner, agent = two
    mine = owner.add_session()["id"]
    theirs = agent.add_session()["id"]
    client = get_client()
    assert isinstance(client, TetherPool)
    assert {s["id"] for s in client.list_sessions()} == {mine, theirs}
    assert {s["id"] for s in session_catalog.list_sessions(include_external=False)} == {mine, theirs}
    created = client.create_session(origin="a-term", cols=80, rows=24)
    assert created["id"] in {s["id"] for s in owner.state.sessions.values()}
    assert created["id"] not in agent.state.sessions


def test_active_instance_follows_tether_socket(two: tuple[FakeTether, FakeTether], monkeypatch: pytest.MonkeyPatch) -> None:
    owner, agent = two
    monkeypatch.setenv("TETHER_SOCKET", agent.socket_path)
    created = get_client().create_session(origin="a-term", cols=80, rows=24)
    assert created["id"] in agent.state.sessions
    assert created["id"] not in owner.state.sessions


def test_session_calls_go_to_the_owning_instance(two: tuple[FakeTether, FakeTether]) -> None:
    owner, agent = two
    theirs = agent.add_session()
    client = get_client()
    assert client.get_session(theirs["id"])["id"] == theirs["id"]
    assert client.attach_target(theirs["id"])
    renamed = client.rename_session(theirs["id"], theirs["generation"], "agent one")
    assert renamed["name"] == "agent one"
    assert session_catalog.end(theirs["id"]) is True
    assert theirs["id"] not in agent.state.sessions
    assert not owner.state.ended
    with pytest.raises(TetherError) as caught:
        client.get_session("deadbeef")
    assert caught.value.status == 404


def test_unreachable_other_instance_hides_its_sessions_but_never_drops_links(
    two: tuple[FakeTether, FakeTether],
) -> None:
    owner, agent = two
    mine = owner.add_session()["id"]
    theirs = agent.add_session()["id"]
    pane = pane_store.create_pane(pane_type="adhoc", pane_name="P")
    pane_store.link_session(mine, pane["id"], "shell")
    pane_store.link_session(theirs, pane["id"], "codex")
    assert lifecycle.reconcile_links()["links_dropped"] == 0  # both seen
    agent.stop()
    assert {s["id"] for s in get_client().list_sessions()} == {mine}
    with pytest.raises(TetherUnavailable):
        lifecycle.reconcile_links()
    assert pane_store.get_link(theirs) is not None
    # A session unknown to both (404 on one, down on the other) is not "gone".
    with pytest.raises(TetherUnavailable):
        get_client().get_session("deadbeef")


def test_reconcile_keeps_links_on_either_instance_and_drops_ended_ones(two: tuple[FakeTether, FakeTether]) -> None:
    owner, agent = two
    mine = owner.add_session()["id"]
    theirs = agent.add_session()["id"]
    pane = pane_store.create_pane(pane_type="adhoc", pane_name="P")
    for session_id in (mine, theirs, "ffffffff"):
        pane_store.link_session(session_id, pane["id"], "shell")
    assert lifecycle.reconcile_links()["links_dropped"] == 1
    assert pane_store.get_link(mine) and pane_store.get_link(theirs)
    assert pane_store.get_link("ffffffff") is None


def test_event_on_one_instance_keeps_the_other_instances_link(two: tuple[FakeTether, FakeTether]) -> None:
    _, agent = two
    theirs = agent.add_session(tool="shell")
    pane = pane_store.create_pane(pane_type="adhoc", pane_name="P")
    pane_store.link_session(theirs["id"], pane["id"], "shell")
    agent.update(theirs["id"], tool="codex")
    # The session.updated event carries no snapshot here: A-Term reads it, and must find it on the agent instance.
    TetherEventWatcher().handle({"type": "session.updated", "data": {"id": theirs["id"]}})
    link = pane_store.get_link(theirs["id"])
    assert link is not None and link["mode"] == "codex"


def test_pinned_unknown_socket_is_the_only_instance(monkeypatch: pytest.MonkeyPatch, tether_down: str) -> None:
    set_client(None)
    client = get_client()
    assert isinstance(client, TetherPool) and [c.socket_path for c in client.clients] == [tether_down]
