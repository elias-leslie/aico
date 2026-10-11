"""Panes API against the fake Tether: panes are A-Term views of Tether sessions."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from a_term.constants import MAX_PANES
from a_term.rate_limit import limiter
from a_term.storage import panes as pane_store

from .fake_tether import FakeTether


@pytest.fixture(autouse=True)
def _reset_rate_limits() -> Iterator[None]:
    limiter.reset()
    yield
    limiter.reset()


def _create(client: TestClient, **body: Any) -> dict[str, Any]:
    payload = {"pane_type": "adhoc", "pane_name": "Ad hoc", **body}
    response = client.post("/api/a-term/panes", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _session_creates(fake: FakeTether) -> list[dict[str, Any]]:
    return [body for method, path, body in fake.calls if (method, path) == ("POST", "/v1/sessions")]


def test_project_pane_creates_shell_and_agent_sessions(test_app: TestClient, fake_tether: FakeTether) -> None:
    pane = _create(test_app, pane_type="project", pane_name="Proj", project_id="proj", working_dir="/tmp")

    creates = _session_creates(fake_tether)
    assert [body["tool"] for body in creates] == ["shell", "codex"]
    assert all(body["origin"] == "a-term" and body["projectId"] == "proj" for body in creates)
    assert all(body["aTermSessionId"] for body in creates)
    assert {s["mode"] for s in pane["sessions"]} == {"shell", "codex"}
    assert pane["active_mode"] == "codex"
    links = pane_store.links_for_pane(pane["id"])
    assert {link["session_id"] for link in links} == {s["id"] for s in pane["sessions"]}


def test_project_pane_uses_requested_tool_alias(test_app: TestClient, fake_tether: FakeTether) -> None:
    pane = _create(test_app, pane_type="project", pane_name="Proj", project_id="proj", agent_tool_slug="claude")
    assert {s["mode"] for s in pane["sessions"]} == {"shell", "claude-code"}
    assert pane["active_mode"] == "claude-code"


def test_project_pane_rejects_unknown_tool(test_app: TestClient, fake_tether: FakeTether) -> None:
    response = test_app.post(
        "/api/a-term/panes",
        json={"pane_type": "project", "pane_name": "P", "project_id": "p", "agent_tool_slug": "nope"},
    )
    assert response.status_code == 404
    assert _session_creates(fake_tether) == []


def test_adhoc_pane_creates_one_shell(test_app: TestClient, fake_tether: FakeTether) -> None:
    pane = _create(test_app)
    assert [s["mode"] for s in pane["sessions"]] == ["shell"]
    assert pane["sessions"][0]["origin"] == "a-term"
    assert pane_store.get_link(pane["sessions"][0]["id"])["pane_id"] == pane["id"]  # type: ignore[index]


def test_project_pane_without_project_id_is_400(test_app: TestClient) -> None:
    response = test_app.post("/api/a-term/panes", json={"pane_type": "project", "pane_name": "P"})
    assert response.status_code == 400


def test_create_rolls_back_when_tether_refuses(test_app: TestClient, fake_tether: FakeTether) -> None:
    fake_tether.state.fail_next["POST /v1/sessions"] = (409, "admission_denied")
    response = test_app.post("/api/a-term/panes", json={"pane_type": "adhoc", "pane_name": "X"})
    assert response.status_code == 409
    assert pane_store.list_panes(include_detached=True) == []


def test_create_when_tether_down_is_503(test_app: TestClient, fake_tether: FakeTether) -> None:
    fake_tether.stop()
    response = test_app.post("/api/a-term/panes", json={"pane_type": "adhoc", "pane_name": "X"})
    assert response.status_code == 503
    assert "Tether" in response.json()["detail"]


def test_max_panes_enforced(test_app: TestClient) -> None:
    for index in range(MAX_PANES):
        _create(test_app, pane_name=f"P{index}")
    response = test_app.post("/api/a-term/panes", json={"pane_type": "adhoc", "pane_name": "over"})
    assert response.status_code == 400
    count = test_app.get("/api/a-term/panes/count").json()
    assert count == {"count": MAX_PANES, "max_panes": MAX_PANES, "at_limit": True}


def test_list_panes_shows_live_sessions_only(test_app: TestClient, fake_tether: FakeTether) -> None:
    live = _create(test_app, pane_name="Live")
    dead = _create(test_app, pane_name="Dead")
    fake_tether.end(dead["sessions"][0]["id"])

    body = test_app.get("/api/a-term/panes").json()
    assert [pane["id"] for pane in body["items"]] == [live["id"]]
    assert body["max_panes"] == MAX_PANES
    assert test_app.get(f"/api/a-term/panes/{dead['id']}").status_code == 404


def test_get_pane_errors(test_app: TestClient) -> None:
    assert test_app.get("/api/a-term/panes/not-a-uuid").status_code == 400
    assert test_app.get("/api/a-term/panes/00000000-0000-0000-0000-000000000000").status_code == 404


def test_delete_pane_ends_its_sessions(test_app: TestClient, fake_tether: FakeTether) -> None:
    pane = _create(test_app, pane_type="project", pane_name="Proj", project_id="proj")
    response = test_app.delete(f"/api/a-term/panes/{pane['id']}")
    assert response.status_code == 200
    assert response.json() == {"deleted": True, "id": pane["id"]}
    ended = {path.split("/")[3] for method, path, _ in fake_tether.calls if path.endswith("/end")}
    assert ended == {s["id"] for s in pane["sessions"]}
    assert fake_tether.state.sessions == {}
    assert pane_store.get_pane(pane["id"]) is None
    assert test_app.delete(f"/api/a-term/panes/{pane['id']}").status_code == 404


def test_switch_agent_tool_uses_load_tui(test_app: TestClient, fake_tether: FakeTether) -> None:
    pane = _create(test_app, pane_type="project", pane_name="Proj", project_id="proj")
    agent = next(s for s in pane["sessions"] if s["mode"] == "codex")

    response = test_app.put(f"/api/a-term/panes/{pane['id']}/agent-tool", json={"agent_tool_slug": "claude"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["active_mode"] == "claude-code"
    assert {s["id"] for s in body["sessions"]} == {s["id"] for s in pane["sessions"]}
    load = [b for m, p, b in fake_tether.calls if p == f"/v1/sessions/{agent['id']}/load-tui"]
    assert load and load[0]["tool"] == "claude-code"
    assert pane_store.get_link(agent["id"])["mode"] == "claude-code"  # type: ignore[index]


def test_switch_agent_tool_refuses_adhoc(test_app: TestClient) -> None:
    pane = _create(test_app)
    response = test_app.put(f"/api/a-term/panes/{pane['id']}/agent-tool", json={"agent_tool_slug": "codex"})
    assert response.status_code == 400


def test_update_active_mode(test_app: TestClient) -> None:
    pane = _create(test_app, pane_type="project", pane_name="Proj", project_id="proj")
    ok = test_app.patch(f"/api/a-term/panes/{pane['id']}", json={"active_mode": "shell", "pane_name": "Renamed"})
    assert ok.status_code == 200
    assert ok.json()["active_mode"] == "shell"
    assert ok.json()["pane_name"] == "Renamed"
    bad = test_app.patch(f"/api/a-term/panes/{pane['id']}", json={"active_mode": "pi"})
    assert bad.status_code == 400


def test_switching_to_shell_recreates_missing_shell(test_app: TestClient, fake_tether: FakeTether) -> None:
    pane = _create(test_app, pane_type="project", pane_name="Proj", project_id="proj")
    shell = next(s for s in pane["sessions"] if s["mode"] == "shell")
    fake_tether.end(shell["id"])

    response = test_app.patch(f"/api/a-term/panes/{pane['id']}", json={"active_mode": "shell"})
    assert response.status_code == 200
    modes = {s["mode"] for s in response.json()["sessions"]}
    assert modes == {"shell", "codex"}
    assert len(_session_creates(fake_tether)) == 3


def test_detach_and_attach(test_app: TestClient) -> None:
    pane = _create(test_app)
    detached = test_app.post(f"/api/a-term/panes/{pane['id']}/detach")
    assert detached.status_code == 200
    assert detached.json()["is_detached"] is True
    assert test_app.get("/api/a-term/panes").json()["total"] == 0
    assert [p["id"] for p in test_app.get("/api/a-term/panes/detached").json()["items"]] == [pane["id"]]

    attached = test_app.post(
        f"/api/a-term/panes/{pane['id']}/attach",
        json={"width_percent": 50.0, "grid_row": 1, "grid_col": 1},
    )
    assert attached.status_code == 200
    body = attached.json()
    assert body["is_detached"] is False
    assert (body["width_percent"], body["grid_row"], body["grid_col"]) == (50.0, 1, 1)


def test_create_detached_pane(test_app: TestClient) -> None:
    pane = _create(test_app, detached=True)
    assert pane["is_detached"] is True
    assert test_app.get("/api/a-term/panes").json()["total"] == 0


def test_layout_updates(test_app: TestClient) -> None:
    first = _create(test_app, pane_name="A")
    second = _create(test_app, pane_name="B")

    one = test_app.patch(f"/api/a-term/panes/{first['id']}/layout", json={"width_percent": 40.0, "grid_col": 0})
    assert one.status_code == 200
    assert one.json()["width_percent"] == 40.0

    bulk = test_app.put(
        "/api/a-term/layout",
        json={"layouts": [
            {"pane_id": first["id"], "width_percent": 30.0, "height_percent": 100.0, "grid_row": 0, "grid_col": 0},
            {"pane_id": second["id"], "width_percent": 70.0, "height_percent": 100.0, "grid_row": 0, "grid_col": 1},
        ]},
    )
    assert bulk.status_code == 200
    widths = {pane["id"]: pane["width_percent"] for pane in bulk.json()}
    assert widths == {first["id"]: 30.0, second["id"]: 70.0}


def test_swap_and_order(test_app: TestClient) -> None:
    first = _create(test_app, pane_name="A")
    second = _create(test_app, pane_name="B")
    swap = test_app.post("/api/a-term/panes/swap", json={"pane_id_a": first["id"], "pane_id_b": second["id"]})
    assert swap.status_code == 200
    assert pane_store.get_pane(first["id"])["pane_order"] == second["pane_order"]  # type: ignore[index]

    order = test_app.put("/api/a-term/panes/order", json={"pane_orders": [[first["id"], 5], [second["id"], 6]]})
    assert order.json() == {"updated": True, "count": 2}
    assert pane_store.get_pane(second["id"])["pane_order"] == 6  # type: ignore[index]

    missing = test_app.post(
        "/api/a-term/panes/swap",
        json={"pane_id_a": first["id"], "pane_id_b": "00000000-0000-0000-0000-000000000000"},
    )
    assert missing.status_code == 404
