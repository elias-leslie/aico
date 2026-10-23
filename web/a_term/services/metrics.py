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

        # Output flushes
        self.flush_count = 0
        self.total_bytes_flushed = 0

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

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            return {
                "uptime_seconds": round(time.monotonic() - self._start_time, 1),
                "output": {
                    "flush_count": self.flush_count,
                    "total_bytes_flushed": self.total_bytes_flushed,
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
