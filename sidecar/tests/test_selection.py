"""Selection-bus tests: the SQLite ring buffer and the HTTP surface."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from aico_sidecar.app import create_app
from aico_sidecar.config import Settings
from aico_sidecar.selection import META_CAP, RING_SIZE, SelectionBus


@pytest.fixture
def bus(tmp_path) -> SelectionBus:
    return SelectionBus(tmp_path / "selections.db")


@pytest.fixture
def client(tmp_path) -> TestClient:
    return TestClient(create_app(Settings(state_dir=tmp_path)))


class TestSelectionBus:
    def test_empty_current_is_none(self, bus: SelectionBus) -> None:
        assert bus.current() is None
        assert bus.history(10) == []

    def test_push_returns_stamped_record(self, bus: SelectionBus) -> None:
        rec = bus.push("dom", "  hello world  ", {"url": "http://x"})
        assert rec["kind"] == "dom"
        assert rec["snippet"] == "hello world"  # trimmed
        assert rec["meta"] == {"url": "http://x"}
        assert rec["widget"] is None and rec["project"] is None
        assert rec["captured_at"].endswith("Z")

    def test_current_returns_newest(self, bus: SelectionBus) -> None:
        bus.push("dom", "first")
        bus.push("region", "second")
        cur = bus.current()
        assert cur is not None and cur["snippet"] == "second"

    def test_history_newest_first(self, bus: SelectionBus) -> None:
        bus.push("dom", "a")
        bus.push("dom", "b")
        bus.push("dom", "c")
        assert [r["snippet"] for r in bus.history(2)] == ["c", "b"]

    def test_ring_prunes_to_size(self, bus: SelectionBus) -> None:
        for i in range(RING_SIZE + 10):
            bus.push("dom", f"s{i}")
        assert len(bus.history(1000)) == RING_SIZE
        cur = bus.current()
        assert cur is not None and cur["snippet"] == f"s{RING_SIZE + 9}"

    def test_invalid_kind_rejected(self, bus: SelectionBus) -> None:
        with pytest.raises(ValueError):
            bus.push("bogus", "x")

    def test_oversized_meta_rejected(self, bus: SelectionBus) -> None:
        with pytest.raises(ValueError, match="meta too large"):
            bus.push("dom", "x", {"blob": "y" * (META_CAP + 1)})

    def test_close_releases_connection(self, bus: SelectionBus) -> None:
        bus.close()
        with pytest.raises(Exception):  # noqa: B017 — sqlite raises on a closed conn
            bus.current()


class TestSelectionRoutes:
    def test_current_empty(self, client: TestClient) -> None:
        assert client.get("/selection/current").json() == {"kind": "empty"}

    def test_history_empty_has_count(self, client: TestClient) -> None:
        assert client.get("/selection/history").json() == {"items": [], "count": 0}

    def test_post_then_read_roundtrip(self, client: TestClient) -> None:
        resp = client.post(
            "/selection",
            json={"kind": "dom", "snippet": "selected text", "meta": {"url": "http://x"}},
        )
        assert resp.status_code == 200
        cur = client.get("/selection/current").json()
        assert cur["kind"] == "dom"
        assert cur["snippet"] == "selected text"
        assert cur["meta"]["url"] == "http://x"
        hist = client.get("/selection/history?n=5").json()
        assert hist["count"] == 1

    def test_post_invalid_kind_is_422(self, client: TestClient) -> None:
        assert client.post("/selection", json={"kind": "bogus", "snippet": "x"}).status_code == 422

    def test_post_oversized_meta_is_422(self, client: TestClient) -> None:
        body = {"kind": "dom", "snippet": "x", "meta": {"blob": "y" * (META_CAP + 1)}}
        assert client.post("/selection", json=body).status_code == 422

    def test_history_n_out_of_range_is_422(self, client: TestClient) -> None:
        assert client.get("/selection/history?n=0").status_code == 422
        assert client.get(f"/selection/history?n={RING_SIZE + 1}").status_code == 422


class TestSelectionSend:
    def test_send_stores_and_returns_records(self, client: TestClient) -> None:
        resp = client.post(
            "/selection/send",
            json={"items": [{"kind": "dom", "snippet": "hi", "meta": {"type": "text"}}]},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 1
        assert body["records"][0]["snippet"] == "hi"
        # also landed in the bus for st selection / hotkey harvest
        assert client.get("/selection/current").json()["snippet"] == "hi"

    def test_send_batch_preserves_order(self, client: TestClient) -> None:
        resp = client.post(
            "/selection/send",
            json={"items": [{"kind": "dom", "snippet": "a"}, {"kind": "dom", "snippet": "b"}]},
        )
        assert resp.status_code == 200
        assert [r["snippet"] for r in resp.json()["records"]] == ["a", "b"]
        # newest-first history: last sent is first
        assert [r["snippet"] for r in client.get("/selection/history").json()["items"]] == ["b", "a"]

    def test_send_empty_items_is_422(self, client: TestClient) -> None:
        assert client.post("/selection/send", json={"items": []}).status_code == 422

    def test_send_invalid_kind_is_422(self, client: TestClient) -> None:
        resp = client.post("/selection/send", json={"items": [{"kind": "bogus", "snippet": "x"}]})
        assert resp.status_code == 422

    def test_events_route_registered(self, tmp_path) -> None:
        # Streaming SSE can't be drained by the sync TestClient without blocking on
        # the keepalive loop. Assert against FastAPI's public OpenAPI surface rather
        # than app.routes: FastAPI 0.139 lazily nests included routers there.
        app = create_app(Settings(state_dir=tmp_path))
        assert "/selection/events" in app.openapi()["paths"]


class TestEventHub:
    def test_publish_fans_out_to_subscribers(self) -> None:
        from aico_sidecar.events import EventHub

        hub = EventHub()
        q1, q2 = hub.register(), hub.register()
        assert hub.subscriber_count == 2
        hub.publish({"records": [{"snippet": "x"}]})
        assert q1.get_nowait() == {"records": [{"snippet": "x"}]}
        assert q2.get_nowait() == {"records": [{"snippet": "x"}]}

    def test_unregister_stops_delivery(self) -> None:
        from aico_sidecar.events import EventHub

        hub = EventHub()
        q = hub.register()
        hub.unregister(q)
        assert hub.subscriber_count == 0
        hub.publish({"records": []})
        assert q.empty()

    def test_full_queue_drops_oldest(self) -> None:
        # A stalled subscriber (never drains) must not grow without bound.
        from aico_sidecar import events

        hub = events.EventHub()
        q = hub.register()
        for i in range(events.MAX_QUEUE + 5):
            hub.publish({"n": i})
        assert q.qsize() == events.MAX_QUEUE  # capped, not MAX_QUEUE + 5
        assert q.get_nowait() == {"n": 5}  # the 5 oldest were dropped
