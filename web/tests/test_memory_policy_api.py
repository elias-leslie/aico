"""Memory policy API: A-Term passes the owner's edits to Tether, which owns the policy."""

from __future__ import annotations

from fastapi.testclient import TestClient

from .fake_tether import FakeTether


def test_get_and_update_memory_policy(test_app: TestClient, fake_tether: FakeTether) -> None:
    got = test_app.get("/api/a-term/memory-policy")
    assert got.status_code == 200
    assert got.json()["policy"]["paneMemoryMaxGib"] == 12
    put = test_app.put("/api/a-term/memory-policy", json={"killOrder": "background-first", "killMinGib": 2})
    assert put.status_code == 200, put.text
    assert put.json()["policy"]["killOrder"] == "background-first"
    sent = next(body for method, path, body in fake_tether.calls if (method, path) == ("PUT", "/v1/memory-policy"))
    assert sent == {"killOrder": "background-first", "killMinGib": 2}


def test_update_refuses_unknown_fields_and_shows_tethers_reason(test_app: TestClient, fake_tether: FakeTether) -> None:
    assert test_app.put("/api/a-term/memory-policy", json={"nope": 1}).status_code == 422
    assert test_app.put("/api/a-term/memory-policy", json={"killOrder": "oldest"}).status_code == 422
    bad = test_app.put("/api/a-term/memory-policy", json={"paneMemoryMaxGib": 1})
    assert bad.status_code == 400 and "from 2 to 64" in bad.json()["detail"]
    assert fake_tether.state.memory_policy["paneMemoryMaxGib"] == 12


def test_tether_down_is_a_plain_503(test_app: TestClient, fake_tether: FakeTether) -> None:
    fake_tether.stop()
    response = test_app.get("/api/a-term/memory-policy")
    assert response.status_code == 503 and "Tether is not reachable" in response.json()["detail"]
