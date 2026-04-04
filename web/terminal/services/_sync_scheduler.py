"""Debounced async scheduler that captures tmux state and dispatches scrollback payloads."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from ..logging_config import get_logger
from ..services.metrics import get_metrics
from ..utils.tmux import get_scrollback_with_cursor
from ._line_diff import LineDiffTracker
from ._scrollback_payload import (
    MAX_SCROLLBACK_CHARS,
    _make_scrollback_payload,
    prepare_scrollback_for_transport,
)

if TYPE_CHECKING:
    from .diagnostics import SessionDiagnostics
    from .recording import SessionRecorder

logger = get_logger(__name__)

SCROLLBACK_SYNC_DELAY_SECONDS = 0.05
SCROLLBACK_SYNC_QUIET_SECONDS = 0.5
# Sync even for small outputs (< min_lines) if no sync has fired in this window.
SCROLLBACK_SYNC_STALENESS_SECONDS = 5.0


class ScrollbackSyncOutputTracker:
    """Trigger syncs after enough cumulative flushed output has arrived."""

    def __init__(
        self,
        scheduler: ScrollbackSyncScheduler,
        *,
        min_lines: int,
    ) -> None:
        self._scheduler = scheduler
        self._min_lines = min_lines
        self._pending_lines = 0
        self._last_output_time = 0.0

    @property
    def last_output_time(self) -> float:
        return self._last_output_time

    def record_output(self, batch: str) -> None:
        self._last_output_time = time.monotonic()
        self._pending_lines += batch.count("\n")
        if self._pending_lines < self._min_lines:
            return
        self._pending_lines = 0
        self._scheduler.notify_output()


class ScrollbackSyncScheduler:
    """Debounce authoritative tmux scrollback syncs after live shell output."""

    def __init__(
        self,
        websocket: Any,
        tmux_session_name: str,
        *,
        delay_seconds: float = SCROLLBACK_SYNC_DELAY_SECONDS,
        quiet_seconds: float = SCROLLBACK_SYNC_QUIET_SECONDS,
        max_chars: int = MAX_SCROLLBACK_CHARS,
        staleness_seconds: float = SCROLLBACK_SYNC_STALENESS_SECONDS,
        get_scrollback_with_cursor_fn: Callable[
            [str], tuple[str | None, tuple[int, int] | None]
        ] = get_scrollback_with_cursor,
        diff_tracker: LineDiffTracker | None = None,
        use_binary: bool = False,
        diag: SessionDiagnostics | None = None,
    ) -> None:
        self._websocket = websocket
        self._tmux_session_name = tmux_session_name
        self._delay_seconds = delay_seconds
        self._quiet_seconds = quiet_seconds
        self._max_chars = max_chars
        self._staleness_seconds = staleness_seconds
        self._get_scrollback_with_cursor = get_scrollback_with_cursor_fn
        self._task: asyncio.Task[None] | None = None
        self._staleness_task: asyncio.Task[None] | None = None
        self._output_tracker: ScrollbackSyncOutputTracker | None = None
        self._diff_tracker = diff_tracker
        self._use_binary = use_binary
        self._diag = diag
        self._sync_count = 0
        self._recorder: SessionRecorder | None = None
        self._last_sync_time: float = 0.0

    def set_recorder(self, recorder: SessionRecorder) -> None:
        self._recorder = recorder

    def set_output_tracker(self, tracker: ScrollbackSyncOutputTracker) -> None:
        self._output_tracker = tracker
        if self._staleness_seconds > 0:
            self._staleness_task = asyncio.create_task(self._staleness_loop())

    def notify_output(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = asyncio.create_task(self._send_after_idle())
        if self._diag is not None:
            self._diag.record("sync_scheduled")

    async def close(self) -> None:
        for task in (self._task, self._staleness_task):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        self._task = None
        self._staleness_task = None

    async def _wait_until_quiet(self) -> None:
        while self._output_tracker:
            since_output = time.monotonic() - self._output_tracker.last_output_time
            if since_output >= self._quiet_seconds:
                break
            await asyncio.sleep(max(self._quiet_seconds - since_output, 0.001))

    def _record_sync_metrics(
        self,
        payload_size: int,
        is_delta: bool,
        cursor_position: tuple[int, int] | None,
        num_changes: int = 0,
    ) -> None:
        m = get_metrics()
        m.inc("sync_count")
        m.inc("delta_count" if is_delta else "full_sync_count")
        m.inc("messages_sent")
        if self._recorder is not None:
            self._recorder.record_sync(payload_size, is_delta=is_delta)
        if self._diag is not None:
            cx = cursor_position[0] if cursor_position else None
            cy = cursor_position[1] if cursor_position else None
            kw: dict[str, Any] = dict(
                is_delta=is_delta,
                payload_size=payload_size,
                seqno=self._sync_count,
                cursor_x=cx,
                cursor_y=cy,
            )
            if is_delta:
                kw["num_changes"] = num_changes
            self._diag.record("sync_sent", **kw)

    async def _send_delta_or_full(
        self,
        prepared: str,
        cursor_position: tuple[int, int] | None,
    ) -> None:
        if self._diff_tracker is not None:
            delta = self._diff_tracker.compute_delta(prepared, cursor_position)
            if not delta.is_full_sync_cheaper:
                payload = delta.to_dict()
                await self._send_payload(payload)
                self._record_sync_metrics(len(str(payload)), True, cursor_position, len(delta.changes))
                return
        payload = _make_scrollback_payload(prepared, cursor_position)
        await self._send_payload(payload)
        self._record_sync_metrics(len(prepared), False, cursor_position)

    async def _send_after_idle(self) -> None:
        try:
            await asyncio.sleep(self._delay_seconds)
            await self._wait_until_quiet()
            scrollback, cursor_position = await asyncio.to_thread(
                self._get_scrollback_with_cursor,
                self._tmux_session_name,
            )
            if not scrollback:
                get_metrics().inc("sync_skipped_count")
                if self._diag is not None:
                    self._diag.record("sync_skipped", reason="empty")
                return
            prepared = prepare_scrollback_for_transport(scrollback, max_chars=self._max_chars)
            if not prepared:
                return
            self._sync_count += 1
            self._last_sync_time = time.monotonic()
            await self._send_delta_or_full(prepared, cursor_position)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "scrollback_sync_failed",
                session=self._tmux_session_name,
                error=str(exc),
            )

    async def _staleness_loop(self) -> None:
        """Periodically trigger a sync if output arrived but never hit min_lines."""
        try:
            while True:
                await asyncio.sleep(self._staleness_seconds)
                if not self._output_tracker:
                    continue
                needs_sync = (
                    self._output_tracker.last_output_time > self._last_sync_time
                    and (self._task is None or self._task.done())
                )
                if not needs_sync:
                    continue
                self._task = asyncio.create_task(self._send_after_idle())
                if self._diag is not None:
                    self._diag.record("sync_scheduled_staleness")
        except asyncio.CancelledError:
            return

    async def _send_payload(self, payload: dict) -> None:
        """Send a control payload via text or binary protocol."""
        if self._use_binary:
            from .binary_protocol import encode_control

            await self._websocket.send_bytes(encode_control(payload))
        else:
            await self._websocket.send_text(json.dumps(payload))
