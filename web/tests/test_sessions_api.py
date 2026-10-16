"""Sessions API: Tether sessions, the user's own tmux sessions, rename, end, reset."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from a_term.rate_limit import limiter
from a_term.storage import panes as pane_store

from . import session_factory as make
from .fake_tether import FakeTether

# A pre-Tether A-Term session (``summitflow-<uuid>``): A-Term no longer shows or ends one.
LEGACY_ID = "70b339cd-93a0-4898-8c4b-3d694ce8e8dc"
LEGACY_ROW = f"summitflow-{LEGACY_ID}\t$1\t%1\t/tmp\tbash\t999999"


@pytest.fixture(autouse=True)
def _reset_rate_limits() -> Iterator[None]:
    limiter.reset()
    yield
    limiter.reset()


def _default_tmux(run: MagicMock, lines: str = LEGACY_ROW) -> list[list[str]]:
    """Make the default tmux server report ``lines`` (one pre-Tether session by default)."""
    calls: list[list[str]] = []

    def fake_run(args: list[str], **_: Any) -> tuple[bool, str]:
        calls.append(list(args))
        if args[0] == "list-panes":
            return True, lines
        if args[0] == "kill-session":
            return True, ""
        return False, "unsupported"

    run.side_effect = fake_run
    return calls


def _pane_with_session(fake: FakeTether, *, detached: bool = False, tool: str = "codex") -> tuple[dict[str, Any], dict[str, Any]]:
    session = fake.add_session(tool=tool, origin="a-term", project_id="proj", project_root="/tmp")
    pane = pane_store.create_pane(pane_type="project", pane_name="P", project_id="proj", active_mode=tool, is_detached=detached)
    pane_store.link_session(session["id"], pane["id"], tool)
    return pane, session


def test_list_includes_tether_sessions_but_not_pre_tether_ones(
    test_app: TestClient, fake_tether: FakeTether, no_default_tmux: MagicMock
) -> None:
    _default_tmux(no_default_tmux)
    pane, linked = _pane_with_session(fake_tether)
    aico = fake_tether.add_session(tool="claude-code", origin="aico")
    older = fake_tether.add_session(status="legacy")

    body = test_app.get("/api/a-term/sessions").json()
    by_id = {item["id"]: item for item in body["items"]}
    assert set(by_id) == {linked["id"], aico["id"], older["id"]}
    assert by_id[linked["id"]]["pane_id"] == pane["id"]
    assert by_id[linked["id"]]["is_external"] is False
    assert by_id[linked["id"]]["origin"] == "a-term"
    assert by_id[aico["id"]]["is_external"] is True
    assert by_id[aico["id"]]["tmux_socket"] == aico["tmux"]["socket"]
    assert by_id[older["id"]]["is_legacy"] is True
    assert by_id[older["id"]]["source"] == "tether"
    assert by_id[linked["id"]]["is_legacy"] is False


def test_titles_and_badges_come_from_tether(test_app: TestClient, fake_tether: FakeTether) -> None:
    """Tether words the title and badge once; A-Term shows them as they are."""
    lead = fake_tether.add_session(name="Lead")
    fake_tether.update(
        lead["id"],
        displayTitle="Personal Workspace — Lead",
        coordinator=True,
        badge={"kind": "coordinator", "text": "Coordinator", "color": "#6fa8ff"},
    )
    lane = fake_tether.add_session(name=" Helper ")
    lane_badge = {"kind": "child", "text": "↳ Lead", "color": "#6fa8ff"}
    fake_tether.update(lane["id"], displayTitle="Project One — Helper", coordinatorId=lead["id"], badge=lane_badge)
    odd = fake_tether.add_session()
    fake_tether.update(odd["id"], displayTitle="  ", badge={"kind": "child", "text": "↳ X", "color": "red"})

    items = {item["id"]: item for item in test_app.get("/api/a-term/sessions").json()["items"]}
    assert items[lead["id"]]["name"] == "Personal Workspace — Lead"
    assert items[lead["id"]]["is_coordinator"] is True
    assert items[lead["id"]]["badge"]["text"] == "Coordinator"
    assert items[lane["id"]]["name"] == "Project One — Helper"
    assert items[lane["id"]]["task"] == "Helper"
    assert items[lane["id"]]["badge"] == lane_badge
    assert items[lane["id"]]["coordinator_id"] == lead["id"]
    # Missing or malformed fields fall back to Tether's label and no badge.
    assert items[odd["id"]]["name"] == odd["label"]
    assert items[odd["id"]]["badge"] is None
    # A title changed elsewhere shows on the next read.
    fake_tether.update(lane["id"], displayTitle="Project One — Renamed")
    assert test_app.get(f"/api/a-term/sessions/{lane['id']}").json()["name"] == "Project One — Renamed"


def test_list_hides_detached_unless_asked(test_app: TestClient, fake_tether: FakeTether) -> None:
    _, session = _pane_with_session(fake_tether, detached=True)
    assert test_app.get("/api/a-term/sessions").json()["total"] == 0
    ids = [item["id"] for item in test_app.get("/api/a-term/sessions?include_detached=true").json()["items"]]
    assert ids == [session["id"]]


def test_list_survives_tether_down(test_app: TestClient, fake_tether: FakeTether, no_default_tmux: MagicMock) -> None:
    _default_tmux(no_default_tmux, make.own_tmux_panes())
    fake_tether.add_session()
    fake_tether.stop()
    ids = [item["id"] for item in test_app.get("/api/a-term/sessions").json()["items"]]
    assert ids == ["claude-work"]


def test_get_session(test_app: TestClient, fake_tether: FakeTether) -> None:
    _, session = _pane_with_session(fake_tether)
    response = test_app.get(f"/api/a-term/sessions/{session['id']}")
    assert response.status_code == 200
    assert response.json()["generation"] == session["generation"]
    assert test_app.get("/api/a-term/sessions/deadbeef").status_code == 404


def test_get_session_tether_down_is_503(test_app: TestClient, fake_tether: FakeTether) -> None:
    fake_tether.stop()
    response = test_app.get("/api/a-term/sessions/deadbeef")
    assert response.status_code == 503
    assert "Tether" in response.json()["detail"]


def test_rename_sends_current_generation(test_app: TestClient, fake_tether: FakeTether) -> None:
    _, session = _pane_with_session(fake_tether)
    response = test_app.patch(f"/api/a-term/sessions/{session['id']}", json={"name": " Build ", "display_order": 3})
    assert response.status_code == 200
    assert response.json()["name"] == "Build"
    assert response.json()["display_order"] == 3
    patch_calls = [body for method, path, body in fake_tether.calls if method == "PATCH"]
    assert patch_calls == [{"generation": session["generation"], "name": "Build"}]


def test_delete_ends_and_is_idempotent(test_app: TestClient, fake_tether: FakeTether) -> None:
    pane, session = _pane_with_session(fake_tether)
    first = test_app.delete(f"/api/a-term/sessions/{session['id']}")
    assert first.status_code == 200
    assert first.json()["pane_deleted"] is True
    assert session["id"] not in fake_tether.state.sessions
    assert pane_store.get_pane(pane["id"]) is None

    again = test_app.delete(f"/api/a-term/sessions/{session['id']}")
    assert again.status_code == 200
    assert again.json()["deleted"] is True


def test_delete_never_kills_a_pre_tether_session(
    test_app: TestClient, no_default_tmux: MagicMock, fake_tether: FakeTether
) -> None:
    calls = _default_tmux(no_default_tmux)
    response = test_app.delete(f"/api/a-term/sessions/{LEGACY_ID}")
    assert response.status_code == 200
    assert response.json()["is_external"] is True
    assert not any(args[0] == "kill-session" for args in calls)


def test_delete_external_session_only_detaches_view(test_app: TestClient, fake_tether: FakeTether) -> None:
    response = test_app.delete("/api/a-term/sessions/my-own-tmux")
    assert response.status_code == 200
    assert response.json()["is_external"] is True
    assert not any(path.endswith("/end") for _, path, _ in fake_tether.calls)


def test_reset_respawns(test_app: TestClient, fake_tether: FakeTether) -> None:
    _, session = _pane_with_session(fake_tether)
    before = session["generation"]  # the fake updates its descriptor in place
    response = test_app.post(f"/api/a-term/sessions/{session['id']}/reset")
    assert response.status_code == 200
    assert response.json()["id"] == session["id"]
    assert response.json()["generation"] != before
    respawns = [body for _, path, body in fake_tether.calls if path.endswith("/respawn")]
    assert respawns == [{"generation": before}]


def test_reset_refuses_a_session_an_older_tether_made(test_app: TestClient, fake_tether: FakeTether) -> None:
    older = fake_tether.add_session(status="legacy")
    response = test_app.post(f"/api/a-term/sessions/{older['id']}/reset")
    assert response.status_code == 409
    assert "attach-only" in response.json()["detail"]


def test_reset_unknown_is_404(test_app: TestClient, fake_tether: FakeTether) -> None:
    assert test_app.post("/api/a-term/sessions/deadbeef/reset").status_code == 404


def test_reset_all_respawns_linked_tether_sessions(test_app: TestClient, fake_tether: FakeTether) -> None:
    _pane_with_session(fake_tether)
    _pane_with_session(fake_tether, tool="shell")
    fake_tether.add_session()  # not shown by A-Term: left alone
    response = test_app.post("/api/a-term/reset-all")
    assert response.json() == {"reset_count": 2}


def test_session_carries_tether_agent_state(test_app: TestClient, fake_tether: FakeTether) -> None:
    _pane, session = _pane_with_session(fake_tether)
    session.update(state="blocked", statePrevious="working", stateAt=1791690000000, stateDetail="permission prompt")
    body = test_app.get(f"/api/a-term/sessions/{session['id']}").json()
    assert (body["activity"], body["activity_previous"], body["activity_at"], body["activity_detail"]) == (
        "blocked", "working", 1791690000000, "permission prompt")
    session.update(state="sideways")
    del session["stateAt"]
    body = test_app.get(f"/api/a-term/sessions/{session['id']}").json()
    assert (body["activity"], body["activity_at"]) == ("unknown", None)
