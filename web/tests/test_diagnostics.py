"""Tests for aterm/services/diagnostics.py."""

from __future__ import annotations

from aterm.services.diagnostics import (
    DiagnosticsRegistry,
    SessionDiagnostics,
    _NoOpDiagnostics,
)


class TestSessionDiagnostics:
    def test_record_and_get_events(self) -> None:
        diag = SessionDiagnostics("sess-1")
        diag.record("pty_flush", batch_size=128)
        diag.record("sync_sent", is_delta=False)

        events = diag.get_events()
        assert len(events) == 2
        assert events[0]["event_type"] == "pty_flush"
        assert events[0]["details"]["batch_size"] == 128
        assert events[1]["event_type"] == "sync_sent"

    def test_ring_buffer_capacity(self) -> None:
        diag = SessionDiagnostics("sess-2", capacity=5)
        for i in range(10):
            diag.record("evt", index=i)
        events = diag.get_events()
        assert len(events) == 5
        # Oldest events evicted
        assert events[0]["details"]["index"] == 5

    def test_get_events_since_filter(self) -> None:
        diag = SessionDiagnostics("sess-3")
        diag.record("a")
        first_ts = diag.get_events()[0]["ts"]
        diag.record("b")
        events = diag.get_events(since=first_ts)
        assert len(events) == 1
        assert events[0]["event_type"] == "b"

    def test_get_events_limit(self) -> None:
        diag = SessionDiagnostics("sess-4")
        for _ in range(10):
            diag.record("x")
        events = diag.get_events(limit=3)
        assert len(events) == 3

    def test_summary(self) -> None:
        diag = SessionDiagnostics("sess-5")
        diag.record("pty_flush")
        diag.record("pty_flush")
        diag.record("sync_sent")
        summary = diag.get_summary()
        assert summary["session_id"] == "sess-5"
        assert summary["total_events"] == 3
        assert summary["counters"]["pty_flush"] == 2
        assert summary["counters"]["sync_sent"] == 1

    def test_disabled_records_nothing(self) -> None:
        diag = SessionDiagnostics("sess-6", enabled=False)
        diag.record("pty_flush")
        assert diag.get_events() == []
        assert diag.get_summary()["total_events"] == 0


class TestNoOpDiagnostics:
    def test_noop_is_free(self) -> None:
        noop = _NoOpDiagnostics("x")
        noop.record("anything", foo="bar")
        assert noop.get_events() == []
        assert noop.get_summary()["total_events"] == 0


class TestDiagnosticsRegistry:
    def test_enabled_creates_real_instance(self) -> None:
        reg = DiagnosticsRegistry(enabled=True)
        diag = reg.get_or_create("sess-a")
        assert isinstance(diag, SessionDiagnostics)
        assert not isinstance(diag, _NoOpDiagnostics)

    def test_disabled_returns_noop(self) -> None:
        reg = DiagnosticsRegistry(enabled=False)
        diag = reg.get_or_create("sess-b")
        assert isinstance(diag, _NoOpDiagnostics)

    def test_get_or_create_idempotent(self) -> None:
        reg = DiagnosticsRegistry(enabled=True)
        d1 = reg.get_or_create("sess-c")
        d2 = reg.get_or_create("sess-c")
        assert d1 is d2

    def test_remove(self) -> None:
        reg = DiagnosticsRegistry(enabled=True)
        reg.get_or_create("sess-d")
        assert "sess-d" in reg.list_sessions()
        reg.remove("sess-d")
        assert "sess-d" not in reg.list_sessions()

    def test_list_sessions(self) -> None:
        reg = DiagnosticsRegistry(enabled=True)
        reg.get_or_create("s1")
        reg.get_or_create("s2")
        assert sorted(reg.list_sessions()) == ["s1", "s2"]
