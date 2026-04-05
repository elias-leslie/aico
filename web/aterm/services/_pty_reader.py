"""Internal helpers for PTY output reading and batching.

Extracted from pty_manager to keep that module concise.
Not part of the public API — import from pty_manager instead.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import os
import re
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from ..logging_config import get_logger

if TYPE_CHECKING:
    from fastapi import WebSocket

    from .backpressure import BackpressureController
    from .diagnostics import SessionDiagnostics

logger = get_logger(__name__)

# Matches tmux client exit message at end of buffer (plain ASCII, no ANSI styling).
# Anchored to end to avoid false positives from user output containing "[exited]".
_TMUX_EXITED_RE = re.compile(r"\[exited\]\r?\n?\s*$")

# Output batching constants (from ghostty/AutoMaker analysis)
FLUSH_INTERVAL_MS = 16  # milliseconds - ~60fps
BATCH_SIZE_LIMIT = 4096  # bytes - 4KB
MAX_UTF8_BUFFER = 4  # UTF-8 chars are max 4 bytes


def _read_pty_data(master_fd: int) -> bytes | None:
    """Read data from PTY fd. Returns None on EOF or error."""
    try:
        data = os.read(master_fd, 8192)
        return data or None
    except OSError as e:
        if e.errno != errno.EIO:
            logger.warning("pty_read_error", error=str(e), errno=e.errno)
        return None
    except Exception as e:
        logger.error("pty_read_unexpected_error", error=str(e))
        return None


def _make_on_readable(
    master_fd: int,
    queue: asyncio.Queue[bytes | None],
    session_id: str = "",
) -> Callable[[], None]:
    """Return a callback for when the PTY fd becomes readable."""
    def on_readable() -> None:
        data = _read_pty_data(master_fd)
        if data is not None:
            queue.put_nowait(data)
        else:
            queue.put_nowait(None)  # EOF

    return on_readable


def _decode_output(
    raw: bytes,
    utf8_buffer: bytes,
) -> tuple[str, bytes]:
    """Decode PTY bytes, handling incomplete UTF-8 sequences.

    Returns:
        (decoded_text, remaining_utf8_buffer)
    """
    output = utf8_buffer + raw
    try:
        return output.decode("utf-8"), b""
    except UnicodeDecodeError as e:
        if e.start >= len(output) - 3:
            # Incomplete sequence at the end — buffer for next read
            incomplete = output[e.start :]
            if len(incomplete) > MAX_UTF8_BUFFER:
                logger.debug("utf8_buffer_overflow", buffer_size=len(incomplete))
                incomplete = b""
            return output[: e.start].decode("utf-8", errors="replace"), incomplete
        return output.decode("utf-8", errors="replace"), b""


async def _flush_batch(
    websocket: WebSocket,
    batch_buffer: str,
    loop: asyncio.AbstractEventLoop,
    on_flush: Callable[[str], Awaitable[None]] | None = None,
    backpressure: BackpressureController | None = None,
    use_binary: bool = False,
    diag: SessionDiagnostics | None = None,
) -> tuple[str, float, bool]:
    """Send buffered output to the websocket.

    Returns:
        (cleared_batch_buffer, new_flush_time, should_continue)
    """
    if batch_buffer:
        if use_binary:
            from .binary_protocol import encode_output

            encoded = encode_output(batch_buffer)
            await websocket.send_bytes(encoded)
            nbytes = len(encoded)
        else:
            await websocket.send_text(batch_buffer)
            nbytes = len(batch_buffer.encode("utf-8"))
        if backpressure is not None:
            backpressure.record_sent(nbytes)
        if on_flush:
            await on_flush(batch_buffer)
        if diag is not None:
            diag.record("pty_flush", batch_size=nbytes, use_binary=use_binary)
        if _TMUX_EXITED_RE.search(batch_buffer):
            logger.info("tmux_session_exited_detected")
            return "", loop.time(), False
    return "", loop.time(), True


def _has_incomplete_escape(text: str) -> bool:
    """Check if text ends with a partial ANSI escape sequence.

    Returns True when the tail of *text* starts with ESC but has no valid
    terminator — holding the batch for ~16ms lets the next PTY chunk
    complete the sequence and prevents TUI visual tearing.
    """
    last_esc = text.rfind("\x1b")
    if last_esc == -1:
        return False
    tail = text[last_esc:]
    if len(tail) < 2:
        return True  # just ESC, not yet categorized
    if tail[1] == "[":  # CSI
        return not any(0x40 <= ord(c) <= 0x7E for c in tail[2:])
    if tail[1] == "]":  # OSC
        return "\x07" not in tail[2:] and "\x1b\\" not in tail[2:]
    if tail[1] == "P":  # DCS
        return "\x1b\\" not in tail[2:]
    return False


async def _run_one_iteration(
    websocket: WebSocket,
    queue: asyncio.Queue[bytes | None],
    loop: asyncio.AbstractEventLoop,
    state: dict,
    wait_time: float,
    on_flush: Callable[[str], Awaitable[None]] | None = None,
    backpressure: BackpressureController | None = None,
    use_binary: bool = False,
    diag: SessionDiagnostics | None = None,
) -> None:
    """Run one iteration: wait for data, decode, and flush when ready."""
    try:
        output = await asyncio.wait_for(queue.get(), timeout=wait_time)
    except TimeoutError:
        # Only flush on timeout if there's no incomplete escape sequence.
        # A split CSI like \x1b[12 renders digits as literal text in xterm.js.
        # If the batch has an incomplete escape, give one more 16ms cycle for
        # the completing chunk to arrive.  After 2 consecutive timeouts with
        # the same incomplete escape, flush anyway (sender stopped mid-sequence).
        if state["batch"] and _has_incomplete_escape(state["batch"]):
            state.setdefault("_esc_hold_count", 0)
            state["_esc_hold_count"] += 1
            if state["_esc_hold_count"] < 2:
                return  # hold for one more cycle
        state["_esc_hold_count"] = 0
        state["batch"], state["flush_time"], ok = await _flush_batch(
            websocket, state["batch"], loop, on_flush, backpressure, use_binary, diag
        )
        if not ok:
            state["running"] = False
        return

    if output is None:
        await _flush_batch(websocket, state["batch"], loop, on_flush, backpressure, use_binary, diag)
        state["running"] = False
        return

    state["_esc_hold_count"] = 0  # reset hold count when data arrives
    decoded, state["utf8"] = _decode_output(output, state["utf8"])
    if decoded:
        state["batch"] += decoded

        size_limit_hit = len(state["batch"]) >= BATCH_SIZE_LIMIT
        incomplete_esc = _has_incomplete_escape(state["batch"])
        # Never flush mid-escape — a split CSI like \x1b[12;1H renders
        # digits as literal text in xterm.js.  If at 4KB with an incomplete
        # escape, wait one more iteration (max 16ms / 8KB extra).
        if not incomplete_esc and (size_limit_hit or queue.empty()):
            state["batch"], state["flush_time"], ok = await _flush_batch(
                websocket, state["batch"], loop, on_flush, backpressure, use_binary, diag
            )
            if not ok:
                state["running"] = False


async def _run_batch_loop(
    websocket: WebSocket,
    queue: asyncio.Queue[bytes | None],
    loop: asyncio.AbstractEventLoop,
    on_flush: Callable[[str], Awaitable[None]] | None = None,
    backpressure: BackpressureController | None = None,
    use_binary: bool = False,
    diag: SessionDiagnostics | None = None,
) -> None:
    """Drive the batching loop: read from queue, decode, flush to websocket."""
    state: dict = {
        "utf8": b"",
        "batch": "",
        "flush_time": loop.time(),
        "running": True,
    }

    try:
        while state["running"]:
            elapsed_ms = (loop.time() - state["flush_time"]) * 1000
            wait_time = max(0.001, (FLUSH_INTERVAL_MS - elapsed_ms) / 1000)
            await _run_one_iteration(
                websocket,
                queue,
                loop,
                state,
                wait_time,
                on_flush,
                backpressure,
                use_binary,
                diag,
            )
    except asyncio.CancelledError:
        with contextlib.suppress(Exception):
            await websocket.send_text(state["batch"])
    except Exception as e:
        logger.error("aterm_output_error", error=str(e))
