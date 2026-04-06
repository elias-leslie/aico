"""Tests for a_term/services/metrics.py."""

from __future__ import annotations

import threading

from a_term.services.metrics import ATermMetrics


class TestATermMetrics:
    def test_initial_values(self) -> None:
        m = ATermMetrics()
        d = m.to_dict()
        assert d["backpressure"]["pause_count"] == 0
        assert d["pty_reader"]["flush_count"] == 0
        assert d["sessions"]["active_sessions"] == 0

    def test_inc_dec(self) -> None:
        m = ATermMetrics()
        m.inc("active_connections")
        m.inc("active_connections")
        m.dec("active_connections")
        assert m.to_dict()["websocket"]["active_connections"] == 1

    def test_inc_amount(self) -> None:
        m = ATermMetrics()
        m.inc("total_bytes_flushed", 4096)
        assert m.to_dict()["pty_reader"]["total_bytes_flushed"] == 4096

    def test_record_pause_resume(self) -> None:
        m = ATermMetrics()
        m.record_pause()
        m.record_resume()
        d = m.to_dict()
        assert d["backpressure"]["pause_count"] == 1
        assert d["backpressure"]["resume_count"] == 1
        assert d["backpressure"]["total_paused_ms"] >= 0

    def test_to_dict_structure(self) -> None:
        m = ATermMetrics()
        d = m.to_dict()
        assert "uptime_seconds" in d
        assert set(d.keys()) == {
            "uptime_seconds",
            "backpressure",
            "pty_reader",
            "scrollback_sync",
            "websocket",
            "sessions",
        }

    def test_thread_safety(self) -> None:
        m = ATermMetrics()
        errors: list[Exception] = []

        def worker() -> None:
            try:
                for _ in range(1000):
                    m.inc("flush_count")
                    m.inc("messages_received")
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert m.to_dict()["pty_reader"]["flush_count"] == 4000
        assert m.to_dict()["websocket"]["messages_received"] == 4000
