"""``/v1/roots``: SummitFlow's A-Term root surface, proxied to Tether."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from a_term.auth import AuthSettings
from a_term.storage import panes as pane_store

from .fake_tether import FakeTether

CREATE = {
    "requestId": "root-1",
    "tool": "codex",
    "projectId": "proj",
    "projectRoot": "/tmp",
    "initialPrompt": "hi",
    "role": "lead",
    "leadRootReference": None,
    "facetCapsuleRef": None,
}


def _create(client: TestClient, body: dict | None = None) -> dict:
    response = client.post("/v1/roots", json=body or CREATE)
    assert response.status_code == 200, response.text
    return response.json()


def test_create_presents_owner_a_term_and_links_a_detached_pane(test_app: TestClient, fake_tether: FakeTether) -> None:
    root = _create(test_app)

    assert root["owner"] == "a-term"
    assert root["requestId"] == "root-1"
    assert root["position"] == {"available": False, "reason": "browser_grid_has_no_pixel_window_bounds"}
    assert root["surfaceLocator"] == f"aico://widget/{root['hostIdentity']}"
    _method, path, body = next(call for call in fake_tether.calls if call[0] == "POST")
    assert (path, body) == ("/v1/roots", CREATE)

    link = pane_store.get_link(root["hostIdentity"])
    assert link is not None and link["mode"] == "codex"
    pane = pane_store.get_pane(link["pane_id"])
    assert pane["is_detached"] and pane["project_id"] == "proj"  # type: ignore[index]


def test_create_is_idempotent_for_the_view(test_app: TestClient) -> None:
    first = _create(test_app)
    _create(test_app)
    assert len(pane_store.list_panes(include_detached=True)) == 1
    assert pane_store.get_link(first["hostIdentity"]) is not None


def test_list_and_get_rewrite_owner(test_app: TestClient) -> None:
    root = _create(test_app)
    listing = test_app.get("/v1/roots").json()
    assert listing["owner"] == "a-term"
    assert listing["position"]["available"] is False
    assert [item["owner"] for item in listing["roots"]] == ["a-term"]

    single = test_app.get(f"/v1/roots/{root['requestId']}")
    assert single.status_code == 200
    assert single.json()["owner"] == "a-term"
    assert single.json()["hostIdentity"] == root["hostIdentity"]


def test_unknown_root_passes_through_404(test_app: TestClient) -> None:
    response = test_app.get("/v1/roots/nope")
    assert response.status_code == 404
    assert response.json() == {"error": "not_found"}


def test_invalid_request_id_is_not_found(test_app: TestClient) -> None:
    assert test_app.get("/v1/roots/-bad").status_code == 404


def test_show_attaches_the_pane_after_a_generation_check(test_app: TestClient) -> None:
    root = _create(test_app)
    response = test_app.post("/v1/roots/root-1/show", json={"generation": root["generation"]})
    assert response.status_code == 200, response.text
    shown = response.json()
    assert (shown["owner"], shown["hostIdentity"], shown["generation"]) == ("a-term", root["hostIdentity"], root["generation"])
    pane = pane_store.get_pane(pane_store.get_link(root["hostIdentity"])["pane_id"])  # type: ignore[index]
    assert not pane["is_detached"]  # type: ignore[index]


def test_show_creates_the_view_when_missing(test_app: TestClient) -> None:
    root = _create(test_app)
    pane_store.delete_pane(pane_store.get_link(root["hostIdentity"])["pane_id"])  # type: ignore[index]
    response = test_app.post("/v1/roots/root-1/show", json={"generation": root["generation"]})
    assert response.status_code == 200
    assert pane_store.get_link(root["hostIdentity"]) is not None


@pytest.mark.parametrize(
    "body",
    [{}, {"generation": "short"}, {"generation": "a" * 64, "extra": 1}, [], {"generation": 5}],
)
def test_show_rejects_invalid_bodies(test_app: TestClient, body) -> None:
    _create(test_app)
    response = test_app.post("/v1/roots/root-1/show", json=body)
    assert response.status_code == 400
    assert response.json() == {"error": "invalid_body"}


def test_non_json_body_is_invalid(test_app: TestClient) -> None:
    _create(test_app)
    response = test_app.post("/v1/roots/root-1/show", content=b"x", headers={"content-type": "text/plain"})
    assert response.status_code == 400


def test_show_with_stale_generation_is_refused(test_app: TestClient) -> None:
    _create(test_app)
    response = test_app.post("/v1/roots/root-1/show", json={"generation": "f" * 64})
    assert response.status_code == 409
    assert response.json() == {"error": "stale_generation"}


def test_show_after_end_is_gone(test_app: TestClient) -> None:
    root = _create(test_app)
    ended = test_app.post("/v1/roots/root-1/end", json={"generation": root["generation"]})
    assert ended.status_code == 200
    assert ended.json()["status"] == "ended"
    assert ended.json()["owner"] == "a-term"
    response = test_app.post("/v1/roots/root-1/show", json={"generation": root["generation"]})
    assert response.status_code == 410
    assert response.json() == {"error": "ended"}


def test_title_renames_the_session_in_tether(test_app: TestClient, fake_tether: FakeTether) -> None:
    root = _create(test_app)
    response = test_app.post("/v1/roots/root-1/title", json={"generation": root["generation"], "label": "  Lead  "})
    assert response.status_code == 200, response.text
    assert response.json()["owner"] == "a-term"
    patch_call = next(call for call in fake_tether.calls if call[0] == "PATCH")
    assert patch_call == ("PATCH", f"/v1/sessions/{root['hostIdentity']}", {"generation": root["generation"], "name": "Lead"})
    assert fake_tether.state.sessions[root["hostIdentity"]]["name"] == "Lead"


@pytest.mark.parametrize("label", ["", "   ", "two\nlines", "bell\x07", "x" * 161, "sep\u2028arator", 5])
def test_title_validates_the_label(test_app: TestClient, label) -> None:
    root = _create(test_app)
    response = test_app.post("/v1/roots/root-1/title", json={"generation": root["generation"], "label": label})
    assert response.status_code == 400
    assert response.json() == {"error": "invalid_body"}


def test_position_is_unavailable_after_the_generation_check(test_app: TestClient) -> None:
    root = _create(test_app)
    bounds = {"x": 0, "y": 0, "width": 800, "height": 600}
    stale = test_app.post("/v1/roots/root-1/position", json={"generation": "f" * 64, "bounds": bounds})
    assert stale.status_code == 409
    response = test_app.post("/v1/roots/root-1/position", json={"generation": root["generation"], "bounds": bounds})
    assert response.status_code == 503
    assert response.json() == {
        "error": "position_unavailable",
        "position": {"available": False, "reason": "browser_grid_has_no_pixel_window_bounds"},
    }


def test_send_passes_through_directed_delivery_unavailable(test_app: TestClient) -> None:
    _create(test_app)
    response = test_app.post("/v1/roots/root-1/send")
    assert response.status_code == 503
    assert response.json()["error"] == "directed_delivery_unavailable"


def test_end_passes_through_and_is_idempotent(test_app: TestClient, fake_tether: FakeTether) -> None:
    root = _create(test_app)
    first = test_app.post("/v1/roots/root-1/end", json={"generation": root["generation"]})
    second = test_app.post("/v1/roots/root-1/end", json={"generation": root["generation"]})
    assert first.status_code == second.status_code == 200
    assert root["hostIdentity"] not in fake_tether.state.sessions


def test_admin_passes_through(test_app: TestClient) -> None:
    _create(test_app)
    assert test_app.get("/v1/roots/root-1/admin").status_code == 503
    assert test_app.post("/v1/roots/root-1/admin", json={}).status_code == 503


def test_unknown_action_is_not_found(test_app: TestClient) -> None:
    _create(test_app)
    assert test_app.post("/v1/roots/root-1/explode", json={}).status_code == 404


def test_non_loopback_clients_are_refused(test_app: TestClient, fake_tether: FakeTether) -> None:
    remote = TestClient(test_app.app, client=("203.0.113.9", 5000))
    response = remote.get("/v1/roots")
    assert response.status_code == 403
    assert response.json() == {"error": "local_only"}
    assert remote.post("/v1/roots", json=CREATE).json() == {"error": "local_only"}
    assert fake_tether.calls == []


def test_foreign_origin_is_refused(test_app: TestClient, fake_tether: FakeTether) -> None:
    response = test_app.post("/v1/roots", json=CREATE, headers={"origin": "https://evil.example"})
    assert response.status_code == 403
    assert response.json() == {"error": "origin_not_allowed"}
    assert fake_tether.calls == []


def test_tether_down_is_owner_failure(tether_down: str, no_default_tmux) -> None:
    with (
        patch("a_term.main.start_scheduler"),
        patch("a_term.main.stop_scheduler"),
        patch("a_term.main.start_watcher"),
        patch("a_term.main.stop_watcher"),
        patch("a_term.main._write_internal_token"),
    ):
        from a_term.main import app

        with TestClient(app, raise_server_exceptions=False) as client:
            for response in (
                client.get("/v1/roots"),
                client.get("/v1/roots/root-1"),
                client.post("/v1/roots", json=CREATE),
                client.post("/v1/roots/root-1/show", json={"generation": "a" * 64}),
                client.post("/v1/roots/root-1/end", json={"generation": "a" * 64}),
            ):
                assert response.status_code == 503
                assert response.json() == {"error": "owner_failure"}


def test_auth_middleware_still_guards_roots(test_app: TestClient, fake_tether: FakeTether) -> None:
    settings = AuthSettings(
        mode="password",
        password="correct horse battery staple",
        secret="test-secret",
        proxy_header="X-Forwarded-User",
        cookie_name="a_term_session",
        cookie_secure=False,
        session_ttl_seconds=3600,
    )
    with patch("a_term.auth.get_auth_settings", return_value=settings):
        assert test_app.get("/v1/roots").status_code == 401
        assert test_app.post("/v1/roots", json=CREATE).status_code == 401
    assert fake_tether.calls == []
