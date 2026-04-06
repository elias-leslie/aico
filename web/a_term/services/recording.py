"""Session recording — persistent JSONL capture of a_term I/O.

Records output, input, sync payloads, and resize events to JSONL files
for replay and post-mortem analysis.  Events are queued in-memory and
drained by a background asyncio task so recording never blocks the
WebSocket hot path.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from pathlib import Path
from typing import Any

from ..logging_config import get_logger

logger = get_logger(__name__)


class SessionRecorder:
    """Async JSONL recorder for a single a_term session."""

    def __init__(
        self,
        session_id: str,
        *,
        recording_dir: Path,
        max_size_bytes: int = 100 * 1024 * 1024,  # 100 MB
    ) -> None:
        self._session_id = session_id
        self._max_size_bytes = max_size_bytes
        self._start_time = time.monotonic()
        self._start_wall = time.time()
        self._queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=4096)
        self._task: asyncio.Task[None] | None = None
        self._size_bytes = 0
        self._event_count = 0
        self._stopped = False

        recording_dir.mkdir(parents=True, exist_ok=True)
        ts_str = time.strftime("%Y%m%d_%H%M%S", time.localtime(self._start_wall))
        self._file_path = recording_dir / f"{session_id}_{ts_str}.jsonl"
        self._cols: int | None = None
        self._rows: int | None = None

    @property
    def file_path(self) -> Path:
        return self._file_path

    @property
    def size_bytes(self) -> int:
        return self._size_bytes

    @property
    def event_count(self) -> int:
        return self._event_count

    @property
    def cols(self) -> int | None:
        return self._cols

    @property
    def rows(self) -> int | None:
        return self._rows

    def start(self) -> None:
        """Start the background writer task."""
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._drain_loop())

    def _ms_since_start(self) -> int:
        return int((time.monotonic() - self._start_time) * 1000)

    def _enqueue(self, event: dict[str, Any]) -> None:
        if self._stopped or self._size_bytes >= self._max_size_bytes:
            return
        with contextlib.suppress(asyncio.QueueFull):
            self._queue.put_nowait(event)

    def record_output(self, data: str) -> None:
        self._enqueue({"t": self._ms_since_start(), "type": "output", "data": data})

    def record_input(self, data: str) -> None:
        self._enqueue({"t": self._ms_since_start(), "type": "input", "data": data})

    def record_sync(self, payload_size: int, is_delta: bool = False) -> None:
        self._enqueue({
            "t": self._ms_since_start(),
            "type": "sync",
            "payload_size": payload_size,
            "is_delta": is_delta,
        })

    def record_resize(self, cols: int, rows: int) -> None:
        self._cols = cols
        self._rows = rows
        self._enqueue({"t": self._ms_since_start(), "type": "resize", "cols": cols, "rows": rows})

    async def stop(self) -> None:
        """Signal the writer to drain remaining events and close."""
        if self._stopped:
            return
        self._stopped = True
        with contextlib.suppress(asyncio.QueueFull):
            self._queue.put_nowait(None)  # sentinel
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (TimeoutError, asyncio.CancelledError):
                self._task.cancel()

    async def _drain_loop(self) -> None:
        try:
            f = self._file_path.open("w", encoding="utf-8")
        except Exception as exc:
            logger.warning("recording_write_error", session_id=self._session_id, error=str(exc))
            return
        try:
            while True:
                event = await self._queue.get()
                if event is None:
                    break
                line = json.dumps(event, separators=(",", ":"))
                f.write(line + "\n")
                f.flush()
                self._size_bytes += len(line) + 1
                self._event_count += 1
                if self._size_bytes >= self._max_size_bytes:
                    logger.info(
                        "recording_size_limit",
                        session_id=self._session_id,
                        size=self._size_bytes,
                    )
                    break
        except Exception as exc:
            logger.warning("recording_write_error", session_id=self._session_id, error=str(exc))
        finally:
            f.close()
