"""Tether's event stream keeps pane links current."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from a_term.services.tether_events import TetherEventWatcher
from a_term.storage import panes as pane_store

from .fake_tether import FakeTether


def test_session_ended_drops_its_link() -> None:
    pane = pane_store.create_pane(pane_type="adhoc", pane_name="P")
    pane_store.link_session("aaaaaaaa", pane["id"], "shell")
    watcher = TetherEventWatcher()
    watcher.handle({"seq": 3, "bootId": "b", "type": "session.ended", "data": {"id": "aaaaaaaa"}})
    assert pane_store.get_link("aaaaaaaa") is None
    # Unknown events and malformed data are ignored.
    watcher.handle({"type": "session.ended", "data": "nope"})
    watcher.handle({"type": "something.new", "data": {}})


def test_gap_reconciles() -> None:
    watcher = TetherEventWatcher()
    with patch("a_term.services.tether_events.lifecycle.reconcile_links", return_value={"links": 0}) as reconcile:
        watcher.handle({"seq": 0, "bootId": "b", "type": "gap", "data": {}})
    reconcile.assert_called_once()


def test_new_boot_resets_resume_cursor() -> None:
    watcher = TetherEventWatcher()
    watcher.handle({"seq": 7, "bootId": "one", "type": "heartbeat"})
    assert (watcher._seq, watcher._boot_id) == (7, "one")
    watcher.handle({"bootId": "two", "type": "hello"})
    assert (watcher._seq, watcher._boot_id) == (None, "two")


def test_reconcile_failure_never_kills_the_watcher() -> None:
    watcher = TetherEventWatcher()
    with patch("a_term.services.tether_events.lifecycle.reconcile_links", side_effect=RuntimeError("boom")):
        watcher.handle({"type": "gap", "data": {}})


def test_watcher_thread_follows_the_stream(fake_tether: FakeTether, no_default_tmux: MagicMock) -> None:
    pane = pane_store.create_pane(pane_type="adhoc", pane_name="P")
    session = fake_tether.add_session()
    pane_store.link_session(session["id"], pane["id"], "shell")
    fake_tether.end(session["id"])  # replayed by the fake's stream
    watcher = TetherEventWatcher()
    watcher.start()
    try:
        import time

        deadline = time.monotonic() + 5
        while pane_store.get_link(session["id"]) is not None and time.monotonic() < deadline:
            time.sleep(0.02)
    finally:
        watcher.stop()
    assert pane_store.get_link(session["id"]) is None


def _linked(session_id: str, mode: str, kind: str = "tether") -> None:
    pane = pane_store.create_pane(pane_type="adhoc", pane_name="P")
    pane_store.link_session(session_id, pane["id"], mode, kind=kind)


def _session_reads(fake_tether: FakeTether, session_id: str) -> int:
    return sum(1 for method, path, _ in fake_tether.calls if method == "GET" and path == f"/v1/sessions/{session_id}")


def test_session_updated_applies_the_snapshot_without_a_read(fake_tether: FakeTether) -> None:
    session = fake_tether.add_session(tool="shell")
    _linked(session["id"], "shell")
    fake_tether.update(session["id"], tool="claude-code")
    event = fake_tether.state.events[-1]
    assert event["data"]["session"]["tool"] == "claude-code"

    TetherEventWatcher().handle(event)

    link = pane_store.get_link(session["id"])
    assert link is not None and link["mode"] == "claude-code"
    assert _session_reads(fake_tether, session["id"]) == 0


def test_session_event_without_a_snapshot_reads_the_session(fake_tether: FakeTether) -> None:
    fake_tether.state.event_snapshots = False  # an older Tether
    session = fake_tether.add_session(tool="shell")
    _linked(session["id"], "shell")
    fake_tether.update(session["id"], tool="codex")
    event = fake_tether.state.events[-1]
    assert "session" not in event["data"]

    TetherEventWatcher().handle(event)

    link = pane_store.get_link(session["id"])
    assert link is not None and link["mode"] == "codex"
    assert _session_reads(fake_tether, session["id"]) == 1


def test_session_event_fallback_drops_a_link_to_a_gone_session(fake_tether: FakeTether) -> None:
    _linked("abababab", "shell")
    TetherEventWatcher().handle({"type": "session.updated", "data": {"id": "abababab"}})
    assert pane_store.get_link("abababab") is None


def test_session_events_for_unlinked_sessions_cost_nothing(fake_tether: FakeTether) -> None:
    fake_tether.state.event_snapshots = False
    session = fake_tether.add_session()
    TetherEventWatcher().handle(fake_tether.state.events[-1])
    assert _session_reads(fake_tether, session["id"]) == 0
    assert pane_store.get_link(session["id"]) is None


def test_legacy_changed_drops_links_to_unlisted_legacy_sessions(fake_tether: FakeTether) -> None:
    kept, gone = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
    _linked(kept, "shell", kind="legacy")
    _linked(gone, "claude-code", kind="legacy")
    _linked("cdcdcdcd", "shell")  # a Tether session is not affected
    fake_tether.legacy_changed([f"summitflow-{kept}"])

    watcher = TetherEventWatcher()
    watcher.handle(fake_tether.state.events[-1])

    assert pane_store.get_link(kept) is not None
    assert pane_store.get_link(gone) is None
    assert pane_store.get_link("cdcdcdcd") is not None
    # A malformed list never drops everything.
    watcher.handle({"type": "legacy.changed", "data": {"names": "nope"}})
    assert pane_store.get_link(kept) is not None
    watcher.handle({"type": "legacy.changed", "data": {"names": []}})
    assert pane_store.get_link(kept) is None
