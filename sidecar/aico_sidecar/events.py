"""In-process async fan-out for sidecar→subscriber push.

The selection bus stores captures; this hub *pushes* a "deliver these" event to
every open subscriber (Electron's SSE stream) the moment a source makes an
explicit send. One queue per subscriber, drained by the SSE endpoint. Loopback,
single-process, low-volume — no broker.
"""

from __future__ import annotations

import asyncio
from typing import Any

# Per-subscriber queue cap. A subscriber that connects but stops draining (a
# stalled SSE client) would otherwise grow its queue without bound on every send;
# we drop the oldest events past this so memory stays bounded. Generously large
# relative to the burst a human can trigger.
MAX_QUEUE = 256


class EventHub:
    """Fan-out of dict events to all registered subscriber queues."""

    def __init__(self) -> None:
        self._queues: set[asyncio.Queue[dict[str, Any]]] = set()

    def register(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=MAX_QUEUE)
        self._queues.add(q)
        return q

    def unregister(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._queues.discard(q)

    def publish(self, event: dict[str, Any]) -> None:
        """Deliver `event` to every subscriber, dropping the oldest queued event
        for any subscriber that has stopped draining (bounded memory)."""
        for q in list(self._queues):
            if q.full():
                try:
                    q.get_nowait()  # drop oldest to make room
                except asyncio.QueueEmpty:  # pragma: no cover - racy drain
                    pass
            q.put_nowait(event)

    @property
    def subscriber_count(self) -> int:
        return len(self._queues)
