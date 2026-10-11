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
