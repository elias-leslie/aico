"""WebSocket backpressure controller.

Prevents OOM when PTY output exceeds browser rendering speed by tracking
unacknowledged bytes and pausing/resuming PTY reads via asyncio FD watching.

Client periodically sends ``{__ctrl: true, commit: <total_bytes_received>}``
messages.  The controller compares ``total_sent - client_committed`` against
watermarks to decide when to pause/resume the reader.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from ..logging_config import get_logger

logger = get_logger(__name__)

HIGH_WATERMARK = 2 * 1024 * 1024  # 2 MB — pause PTY reads
LOW_WATERMARK = 512 * 1024  # 512 KB — resume PTY reads


class BackpressureController:
    """Track unacked bytes and pause/resume PTY FD reading."""

    __slots__ = (
        "_client_committed",
        "_closed",
        "_loop",
        "_master_fd",
        "_on_readable",
        "_paused",
        "_total_sent",
    )

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        master_fd: int,
        on_readable: Callable[[], None],
    ) -> None:
        self._loop = loop
        self._master_fd = master_fd
        self._on_readable = on_readable
        self._total_sent: int = 0
        self._client_committed: int = 0
        self._paused: bool = False
        self._closed: bool = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def record_sent(self, nbytes: int) -> None:
        """Call after each ``websocket.send_*`` with the byte length sent."""
        self._total_sent += nbytes
        if not self._paused and self._unacked >= HIGH_WATERMARK:
            self._pause()

    def record_commit(self, client_total: int) -> None:
        """Call when the client sends a ``commit`` control message."""
        # Clamp to total_sent — stale / out-of-order commits must not underflow.
        self._client_committed = min(client_total, self._total_sent)
        if self._paused and self._unacked <= LOW_WATERMARK:
            self._resume()

    @property
    def paused(self) -> bool:
        return self._paused

    def close(self) -> None:
        """Idempotent cleanup."""
        if self._closed:
            return
        self._closed = True
        if self._paused:
            # Don't try to resume a closed controller — reader is gone.
            self._paused = False

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @property
    def _unacked(self) -> int:
        return self._total_sent - self._client_committed

    def _pause(self) -> None:
        if self._paused or self._closed:
            return
        self._paused = True
        self._loop.remove_reader(self._master_fd)
        from .metrics import get_metrics

        get_metrics().record_pause()
        logger.debug(
            "backpressure_pause",
            unacked=self._unacked,
            total_sent=self._total_sent,
        )

    def _resume(self) -> None:
        if not self._paused or self._closed:
            return
        self._paused = False
        self._loop.add_reader(self._master_fd, self._on_readable)
        from .metrics import get_metrics

        get_metrics().record_resume()
        logger.debug(
            "backpressure_resume",
            unacked=self._unacked,
            total_sent=self._total_sent,
        )
