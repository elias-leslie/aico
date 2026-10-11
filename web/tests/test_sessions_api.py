"""Sessions API: Tether sessions, legacy default-server sessions, rename, end, reset."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from a_term.rate_limit import limiter
from a_term.storage import panes as pane_store

from .fake_tether import FakeTether

LEGACY_ID = "70b339cd-93a0-4898-8c4b-3d694ce8e8dc"
LEGACY_ROW = f"summitflow-{LEGACY_ID}\t$1\t%1\t/tmp\tbash\t999999"


@pytest.fixture(autouse=True)
def _reset_rate_limits() -> Iterator[None]:
    limiter.reset()
    yield
    limiter.reset()


def _legacy_tmux(run: MagicMock, *, alive: bool = True) -> list[list[str]]:
    """Make the default tmux server report one legacy A-Term session."""
    calls: list[list[str]] = []

    def fake_run(args: list[str], **_: Any) -> tuple[bool, str]:
        calls.append(list(args))
        if args[0] == "list-panes":
            return (True, LEGACY_ROW) if alive else (False, "no server running")
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


def test_list_includes_tether_and_legacy(test_app: TestClient, fake_tether: FakeTether, no_default_tmux: MagicMock) -> None:
    _legacy_tmux(no_default_tmux)
    pane, linked = _pane_with_session(fake_tether)
    aico = fake_tether.add_session(tool="claude-code", origin="aico")

    body = test_app.get("/api/a-term/sessions").json()
    by_id = {item["id"]: item for item in body["items"]}
    assert set(by_id) == {linked["id"], aico["id"], LEGACY_ID}
    assert by_id[linked["id"]]["pane_id"] == pane["id"]
    assert by_id[linked["id"]]["is_external"] is False
    assert by_id[linked["id"]]["origin"] == "a-term"
    assert by_id[aico["id"]]["is_external"] is True
    assert by_id[aico["id"]]["tmux_socket"] == aico["tmux"]["socket"]
    legacy = by_id[LEGACY_ID]
    assert legacy["is_legacy"] is True
    assert legacy["tmux_session_name"] == f"summitflow-{LEGACY_ID}"
    assert legacy["tmux_socket"] is None


def test_list_hides_detached_unless_asked(test_app: TestClient, fake_tether: FakeTether) -> None:
    _, session = _pane_with_session(fake_tether, detached=True)
    assert test_app.get("/api/a-term/sessions").json()["total"] == 0
    ids = [item["id"] for item in test_app.get("/api/a-term/sessions?include_detached=true").json()["items"]]
    assert ids == [session["id"]]


def test_list_survives_tether_down(test_app: TestClient, fake_tether: FakeTether, no_default_tmux: MagicMock) -> None:
    _legacy_tmux(no_default_tmux)
    fake_tether.add_session()
    fake_tether.stop()
    ids = [item["id"] for item in test_app.get("/api/a-term/sessions").json()["items"]]
    assert ids == [LEGACY_ID]


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


def test_rename_refuses_legacy(test_app: TestClient, no_default_tmux: MagicMock, fake_tether: FakeTether) -> None:
    _legacy_tmux(no_default_tmux)
    response = test_app.patch(f"/api/a-term/sessions/{LEGACY_ID}", json={"name": "x"})
    assert response.status_code == 400


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


def test_delete_legacy_kills_exact_session(test_app: TestClient, no_default_tmux: MagicMock, fake_tether: FakeTether) -> None:
    calls = _legacy_tmux(no_default_tmux)
    response = test_app.delete(f"/api/a-term/sessions/{LEGACY_ID}")
    assert response.status_code == 200
    assert ["kill-session", "-t", f"=summitflow-{LEGACY_ID}"] in calls


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


def test_reset_refuses_legacy(test_app: TestClient, no_default_tmux: MagicMock, fake_tether: FakeTether) -> None:
    _legacy_tmux(no_default_tmux)
    response = test_app.post(f"/api/a-term/sessions/{LEGACY_ID}/reset")
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
