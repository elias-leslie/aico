"""Per-session diagnostic event tracing.

Captures timestamped events (PTY flushes, scrollback syncs, input, etc.)
in an in-memory ring buffer so we can correlate the exact interleaving
of writes, snapshots, and deltas when TUI jumping occurs.

When ``diagnostics_enabled=False`` (the default), ``DiagnosticsRegistry``
returns a no-op instance whose ``record()`` is essentially free.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class DiagnosticEvent:
    """A single diagnostic event."""

    ts: float  # time.monotonic()
    wall_ts: float  # time.time()
    event_type: str
    session_id: str
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ts": self.ts,
            "wall_ts": self.wall_ts,
            "event_type": self.event_type,
            "session_id": self.session_id,
            "details": self.details,
        }


# Default ring-buffer capacity (~200KB at ~100 bytes/event)
_DEFAULT_CAPACITY = 2000


class SessionDiagnostics:
    """Per-session ring buffer of diagnostic events."""

    __slots__ = ("_buffer", "_capacity", "_counters", "_enabled", "_session_id")

    def __init__(self, session_id: str, *, capacity: int = _DEFAULT_CAPACITY, enabled: bool = True) -> None:
        self._session_id = session_id
        self._capacity = capacity
        self._enabled = enabled
        self._buffer: deque[DiagnosticEvent] = deque(maxlen=capacity)
        self._counters: dict[str, int] = {}

    def record(self, event_type: str, **details: Any) -> None:
        """Append an event to the ring buffer and bump the counter."""
        if not self._enabled:
            return
        now = time.monotonic()
        wall = time.time()
        self._buffer.append(
            DiagnosticEvent(
                ts=now,
                wall_ts=wall,
                event_type=event_type,
                session_id=self._session_id,
                details=details,
            )
        )
        self._counters[event_type] = self._counters.get(event_type, 0) + 1

    def get_events(self, *, since: float = 0.0, limit: int = 500) -> list[dict[str, Any]]:
        """Return events after *since* (monotonic ts), up to *limit*."""
        out: list[dict[str, Any]] = []
        for ev in self._buffer:
            if ev.ts <= since:
                continue
            out.append(ev.to_dict())
            if len(out) >= limit:
                break
        return out

    def get_summary(self) -> dict[str, Any]:
        return {
            "session_id": self._session_id,
            "total_events": len(self._buffer),
            "capacity": self._capacity,
            "counters": dict(self._counters),
        }


class _NoOpDiagnostics(SessionDiagnostics):
    """Zero-cost stand-in when diagnostics are disabled."""

    def __init__(self, session_id: str) -> None:
        super().__init__(session_id, enabled=False)

    def record(self, event_type: str, **details: Any) -> None:
        pass

    def get_events(self, *, since: float = 0.0, limit: int = 500) -> list[dict[str, Any]]:
        return []

    def get_summary(self) -> dict[str, Any]:
        return {"session_id": "", "total_events": 0, "capacity": 0, "counters": {}}


_NOOP = _NoOpDiagnostics("")


class DiagnosticsRegistry:
    """Global registry of per-session diagnostics."""

    def __init__(self, *, enabled: bool = False) -> None:
        self._enabled = enabled
        self._sessions: dict[str, SessionDiagnostics] = {}

    @property
    def enabled(self) -> bool:
        return self._enabled

    def get_or_create(self, session_id: str) -> SessionDiagnostics:
        if not self._enabled:
            return _NOOP
        diag = self._sessions.get(session_id)
        if diag is None:
            diag = SessionDiagnostics(session_id)
            self._sessions[session_id] = diag
        return diag

    def remove(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def list_sessions(self) -> list[str]:
        return list(self._sessions)

    def get(self, session_id: str) -> SessionDiagnostics | None:
        return self._sessions.get(session_id)


# Module-level singleton — initialized at startup from config
_registry: DiagnosticsRegistry | None = None


def get_registry() -> DiagnosticsRegistry:
    global _registry
    if _registry is None:
        from ..config import get_settings

        _registry = DiagnosticsRegistry(enabled=get_settings().diagnostics_enabled)
    return _registry
