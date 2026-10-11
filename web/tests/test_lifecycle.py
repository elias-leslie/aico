"""Session lifecycle delegated to the (fake) Tether."""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

import pytest

from a_term.services import lifecycle
from a_term.storage import panes as pane_store
from a_term.tether import TetherError, TetherUnavailable

from .fake_tether import FakeTether

LEGACY_ID = "70b339cd-93a0-4898-8c4b-3d694ce8e8dc"


@pytest.fixture()
def tether(fake_tether: FakeTether, no_default_tmux: MagicMock) -> FakeTether:
    return fake_tether


def _pane() -> dict:
    return pane_store.create_pane(pane_type="project", pane_name="P", project_id="proj")


def test_create_session_asks_tether_with_a_term_origin_and_links(tether: FakeTether) -> None:
    pane = _pane()
    session = lifecycle.create_session(pane_id=pane["id"], mode="claude", project_id="proj", working_dir="/tmp")

    method, path, body = tether.calls[-1]
    assert (method, path) == ("POST", "/v1/sessions")
    assert body["origin"] == "a-term"
    assert body["tool"] == "claude" and body["projectId"] == "proj" and body["projectRoot"] == "/tmp"
    uuid.UUID(body["aTermSessionId"])
    assert set(body["size"]) == {"cols", "rows"}

    assert session["mode"] == "claude-code"  # Tether's canonical slug
    link = pane_store.get_link(session["id"])
    assert link is not None and link["pane_id"] == pane["id"] and link["mode"] == "claude-code"
    assert session["is_external"] is False and session["source"] == "tether"


def test_create_pane_with_sessions_creates_shell_and_agent(tether: FakeTether) -> None:
    pane = lifecycle.create_pane_with_sessions(pane_type="project", pane_name="P", project_id="proj")
    assert [s["mode"] for s in pane["sessions"]] == ["shell", "codex"]  # codex is Tether's default
    assert pane["active_mode"] == "codex"
    adhoc = lifecycle.create_pane_with_sessions(pane_type="adhoc", pane_name="Scratch")
    assert [s["mode"] for s in adhoc["sessions"]] == ["shell"]


def test_create_pane_rolls_back_when_tether_refuses_a_session(tether: FakeTether) -> None:
    with pytest.raises(TetherError) as caught:
        lifecycle.create_pane_with_sessions(
            pane_type="project", pane_name="P", project_id="proj", agent_tool_slug="no-such-tool"
        )
    assert caught.value.code == "unknown_tool"
    assert pane_store.list_panes(include_detached=True) == []
    assert pane_store.list_links() == []
    assert tether.state.sessions == {}  # the shell created first was ended
    assert len(tether.state.ended) == 1


def test_end_tether_session_is_generation_fenced_and_unlinks(tether: FakeTether) -> None:
    pane = _pane()
    session = lifecycle.create_session(pane_id=pane["id"], mode="shell")
    assert lifecycle.end_session(session["id"]) is True
    _, path, body = tether.calls[-1]
    assert path == f"/v1/sessions/{session['id']}/end"
    assert len(body["generation"]) == 64
    assert pane_store.get_link(session["id"]) is None
    # Already gone: reported, never an error.
    assert lifecycle.end_session(session["id"]) is False


def test_end_legacy_session_kills_exact_session(tether: FakeTether) -> None:
    pane = _pane()
    pane_store.link_session(LEGACY_ID, pane["id"], "shell", kind="legacy")
    with patch("a_term.utils.tmux.kill_legacy_session", return_value=True) as kill:
        assert lifecycle.end_session(LEGACY_ID) is True
    kill.assert_called_once_with(LEGACY_ID)
    assert pane_store.get_link(LEGACY_ID) is None


def test_end_refuses_external_session(tether: FakeTether) -> None:
    with pytest.raises(lifecycle.LifecycleError):
        lifecycle.end_session("my-own-session")


def test_end_pane_ends_every_session_and_deletes_pane(tether: FakeTether) -> None:
    pane = lifecycle.create_pane_with_sessions(pane_type="project", pane_name="P", project_id="proj")
    assert lifecycle.end_pane(pane["id"]) == 2
    assert pane_store.get_pane(pane["id"]) is None
    assert tether.state.sessions == {}


def test_reset_respawns_with_new_generation(tether: FakeTether) -> None:
    pane = _pane()
    session = lifecycle.create_session(pane_id=pane["id"], mode="codex")
    refreshed = lifecycle.reset_session(session["id"])
    assert refreshed["id"] == session["id"]
    assert refreshed["generation"] != session["generation"]


@pytest.mark.parametrize(
    ("session", "status"),
    [
        (None, 404),
        ({"is_legacy": True, "source": "legacy"}, 409),
        ({"is_root": True, "source": "tether"}, 409),
        ({"source": "tmux_external"}, 400),
    ],
)
def test_reset_refuses_legacy_root_and_external(tether: FakeTether, session: dict | None, status: int) -> None:
    with (
        patch("a_term.services.lifecycle.session_catalog.get_session", return_value=session),
        pytest.raises(lifecycle.LifecycleError) as caught,
    ):
        lifecycle.reset_session("aaaaaaaa")
    assert caught.value.status_code == status


def test_load_tool_switches_tool_and_remembers_it(tether: FakeTether) -> None:
    pane = _pane()
    session = lifecycle.create_session(pane_id=pane["id"], mode="codex")
    loaded = lifecycle.load_tool(session["id"], "claude")
    assert loaded["mode"] == "claude-code"
    assert pane_store.get_link(session["id"])["mode"] == "claude-code"  # type: ignore[index]


def test_disable_project_ends_sessions_and_disables_tab(tether: FakeTether) -> None:
    from a_term.storage import project_settings

    lifecycle.create_pane_with_sessions(pane_type="project", pane_name="P", project_id="proj")
    assert lifecycle.disable_project_a_term("proj") == 2
    assert project_settings.get_settings("proj")["enabled"] is False  # type: ignore[index]
    assert pane_store.list_panes(include_detached=True) == []


def test_reconcile_drops_links_of_ended_sessions(tether: FakeTether) -> None:
    pane = _pane()
    alive = lifecycle.create_session(pane_id=pane["id"], mode="shell")
    gone = lifecycle.create_session(pane_id=pane["id"], mode="codex")
    tether.end(gone["id"])
    pane_store.link_session(LEGACY_ID, pane["id"], "shell", kind="legacy")  # its tmux session is gone too

    stats = lifecycle.reconcile_links()

    assert stats == {"links": 3, "links_dropped": 2, "panes_pruned": 0}
    assert [link["session_id"] for link in pane_store.list_links()] == [alive["id"]]


def test_reconcile_keeps_live_legacy_links(tether: FakeTether) -> None:
    pane = _pane()
    pane_store.link_session(LEGACY_ID, pane["id"], "shell", kind="legacy")
    with patch("a_term.utils.tmux.list_tmux_sessions", return_value={LEGACY_ID}):
        assert lifecycle.reconcile_links()["links_dropped"] == 0


def test_reconcile_never_treats_tether_down_as_all_ended(tether_down: str, no_default_tmux: MagicMock) -> None:
    pane = _pane()
    pane_store.link_session("aaaaaaaa", pane["id"], "shell")
    with pytest.raises(TetherUnavailable):
        lifecycle.reconcile_links()
    assert pane_store.get_link("aaaaaaaa") is not None
