"""Global production metrics for the a_term service.

Thread-safe counters exposed via ``GET /metrics`` for observability.
Uses a simple dict + lock approach — no external dependency needed.
"""

from __future__ import annotations

import threading
import time
from typing import Any


class ATermMetrics:
    """Singleton metrics collector with thread-safe counters."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._start_time = time.monotonic()

        # Backpressure
        self.pause_count = 0
        self.resume_count = 0
        self.total_paused_ms = 0.0
        self._pause_start: float | None = None

        # PTY reader
        self.flush_count = 0
        self.total_bytes_flushed = 0

        # Scrollback sync
        self.sync_count = 0
        self.sync_skipped_count = 0
        self.delta_count = 0
        self.full_sync_count = 0

        # WebSocket
        self.active_connections = 0
        self.messages_received = 0
        self.messages_sent = 0

        # Sessions
        self.active_sessions = 0
        self.total_sessions_created = 0

    def inc(self, name: str, amount: int = 1) -> None:
        with self._lock:
            setattr(self, name, getattr(self, name) + amount)

    def dec(self, name: str, amount: int = 1) -> None:
        with self._lock:
            setattr(self, name, getattr(self, name) - amount)

    def record_pause(self) -> None:
        with self._lock:
            self.pause_count += 1
            self._pause_start = time.monotonic()

    def record_resume(self) -> None:
        with self._lock:
            self.resume_count += 1
            if self._pause_start is not None:
                self.total_paused_ms += (time.monotonic() - self._pause_start) * 1000
                self._pause_start = None

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            return {
                "uptime_seconds": round(time.monotonic() - self._start_time, 1),
                "backpressure": {
                    "pause_count": self.pause_count,
                    "resume_count": self.resume_count,
                    "total_paused_ms": round(self.total_paused_ms, 1),
                },
                "pty_reader": {
                    "flush_count": self.flush_count,
                    "total_bytes_flushed": self.total_bytes_flushed,
                },
                "scrollback_sync": {
                    "sync_count": self.sync_count,
                    "sync_skipped_count": self.sync_skipped_count,
                    "delta_count": self.delta_count,
                    "full_sync_count": self.full_sync_count,
                },
                "websocket": {
                    "active_connections": self.active_connections,
                    "messages_received": self.messages_received,
                    "messages_sent": self.messages_sent,
                },
                "sessions": {
                    "active_sessions": self.active_sessions,
                    "total_sessions_created": self.total_sessions_created,
                },
            }


_instance: ATermMetrics | None = None


def get_metrics() -> ATermMetrics:
    global _instance
    if _instance is None:
        _instance = ATermMetrics()
    return _instance
