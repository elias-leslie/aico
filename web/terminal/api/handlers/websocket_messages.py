"""WebSocket message handling logic."""

from __future__ import annotations

import asyncio
import json
import os
from typing import TYPE_CHECKING, Any

from ...config import (
    TMUX_DEFAULT_COLS,
    TMUX_DEFAULT_ROWS,
    TMUX_MAX_COLS,
    TMUX_MAX_ROWS,
    TMUX_MIN_COLS,
    TMUX_MIN_ROWS,
)
from ...logging_config import get_logger
from ...services.pty_manager import resize_pty
from ...utils.tmux import resize_tmux_window

if TYPE_CHECKING:
    from fastapi import WebSocket

    from ...services.backpressure import BackpressureController
    from ...services.recording import SessionRecorder

logger = get_logger(__name__)

MAX_SCROLL_PAGE_SIZE = 5000


def _clamp_dimension(value: int, min_val: int, max_val: int) -> int:
    """Clamp a dimension value between min and max."""
    return min(max(value, min_val), max_val)


def _extract_capabilities(data: dict[str, Any], capabilities: list[str] | None) -> None:
    """Populate capabilities list from control message, if present."""
    if capabilities is None:
        return
    caps = data.get("capabilities")
    if isinstance(caps, list):
        capabilities.clear()
        capabilities.extend(caps)


async def _handle_resize_command(
    data: dict[str, Any],
    master_fd: int,
    session_id: str,
    tmux_session_name: str | None,
    last_resize: list[int] | None,
    resize_tmux: bool,
) -> tuple[int, int]:
    """Handle a resize JSON command."""
    resize = data.get("resize", {})
    cols = _clamp_dimension(int(resize.get("cols", TMUX_DEFAULT_COLS)), TMUX_MIN_COLS, TMUX_MAX_COLS)
    rows = _clamp_dimension(int(resize.get("rows", TMUX_DEFAULT_ROWS)), TMUX_MIN_ROWS, TMUX_MAX_ROWS)

    # Skip PTY/tmux resize if dimensions unchanged (dedup)
    if not last_resize or cols != last_resize[0] or rows != last_resize[1]:
        resize_pty(master_fd, cols, rows)
        if resize_tmux and tmux_session_name:
            await asyncio.to_thread(resize_tmux_window, tmux_session_name, cols, rows)
        if last_resize is not None:
            last_resize[0] = cols
            last_resize[1] = rows
        logger.info("terminal_resized", session_id=session_id, cols=cols, rows=rows)

    return (cols, rows)


async def _handle_scroll_request(
    data: dict[str, Any],
    websocket: WebSocket,
    tmux_session_name: str | None,
) -> None:
    """Handle a scroll_request control message — return a scrollback page."""
    req = data.get("scroll_request", {})
    count = min(int(req.get("count", 100)), MAX_SCROLL_PAGE_SIZE)

    if not tmux_session_name:
        return

    from ...services.scrollback_pager import get_scrollback_line_count, get_scrollback_range

    # "Latest" mode: when from_line is omitted, fetch the most recent lines
    if "from_line" in req:
        from_line = int(req["from_line"])
    else:
        total = await asyncio.to_thread(get_scrollback_line_count, tmux_session_name)
        if total is None:
            return
        from_line = max(0, total - count)

    result = await asyncio.to_thread(get_scrollback_range, tmux_session_name, from_line, count)
    if result is None:
        return

    lines, total_lines = result
    payload = {
        "__ctrl": True,
        "scrollback_page": {
            "from_line": from_line,
            "lines": lines,
            "total_lines": total_lines,
        },
    }
    await websocket.send_text(json.dumps(payload))


async def _handle_ctrl_message(
    data: dict[str, Any],
    master_fd: int,
    session_id: str,
    tmux_session_name: str | None,
    last_resize: list[int] | None,
    resize_tmux: bool,
    backpressure: BackpressureController | None,
    websocket: WebSocket | None,
    capabilities: list[str] | None,
) -> tuple[int, int] | None:
    """Dispatch a validated __ctrl message to the appropriate handler."""
    if "resize" in data:
        _extract_capabilities(data, capabilities)
        return await _handle_resize_command(data, master_fd, session_id, tmux_session_name, last_resize, resize_tmux)

    if data.get("ping"):
        return None

    if data.get("refresh"):
        await asyncio.to_thread(os.write, master_fd, b"\x0c")
        logger.debug("terminal_refreshed", session_id=session_id)
        return None

    # Phase 1: Backpressure commit
    if "commit" in data and backpressure is not None:
        backpressure.record_commit(int(data["commit"]))
        return None

    # Phase 3: Scroll request
    if "scroll_request" in data and websocket is not None:
        await _handle_scroll_request(data, websocket, tmux_session_name)
        return None

    return None


async def _handle_text_message(
    text: str,
    master_fd: int,
    session_id: str,
    tmux_session_name: str | None,
    last_resize: list[int] | None,
    resize_tmux: bool,
    backpressure: BackpressureController | None = None,
    websocket: WebSocket | None = None,
    capabilities: list[str] | None = None,
    recorder: SessionRecorder | None = None,
) -> tuple[int, int] | None:
    """Handle a text WebSocket message, dispatching JSON control or raw input.

    Control messages must include '__ctrl': true to distinguish them from
    user-typed JSON that happens to match control message structure.
    """
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            await asyncio.to_thread(os.write, master_fd, text.encode("utf-8"))
            return None

        if data.get("__ctrl"):
            return await _handle_ctrl_message(
                data, master_fd, session_id, tmux_session_name,
                last_resize, resize_tmux, backpressure, websocket, capabilities,
            )

    input_bytes = text.encode("utf-8")
    await asyncio.to_thread(os.write, master_fd, input_bytes)
    if recorder is not None:
        recorder.record_input(text)
    return None


async def _handle_binary_message(
    raw: bytes,
    master_fd: int,
    session_id: str,
    tmux_session_name: str | None,
    last_resize: list[int] | None,
    resize_tmux: bool,
    backpressure: BackpressureController | None,
    websocket: WebSocket | None,
    capabilities: list[str] | None,
    recorder: SessionRecorder | None,
) -> tuple[int, int] | None:
    """Handle a binary WebSocket message via the framed binary protocol."""
    # Phase 5: Binary protocol — decode framed messages
    if len(raw) > 1:
        from ...services.binary_protocol import MSG_CONTROL, MSG_INPUT, decode_client_message

        msg_type, payload = decode_client_message(raw)
        if msg_type == MSG_INPUT:
            await asyncio.to_thread(os.write, master_fd, payload)
            if recorder is not None:
                recorder.record_input(payload.decode("utf-8", errors="replace"))
            return None
        if msg_type == MSG_CONTROL:
            try:
                text = payload.decode("utf-8")
                return await _handle_text_message(
                    text, master_fd, session_id, tmux_session_name,
                    last_resize, resize_tmux, backpressure, websocket, capabilities, recorder,
                )
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass

    # Legacy binary — forward raw bytes to PTY
    await asyncio.to_thread(os.write, master_fd, raw)
    return None


async def handle_websocket_message(
    message: Any,
    master_fd: int,
    session_id: str,
    tmux_session_name: str | None = None,
    last_resize: list[int] | None = None,
    resize_tmux: bool = True,
    backpressure: BackpressureController | None = None,
    websocket: WebSocket | None = None,
    capabilities: list[str] | None = None,
    recorder: SessionRecorder | None = None,
) -> tuple[int, int] | None:
    """Handle a single WebSocket message.

    Args:
        message: WebSocket message dict
        master_fd: Master file descriptor to write to
        session_id: Terminal session ID (for logging)
        tmux_session_name: tmux session name for resize operations
        last_resize: Mutable [cols, rows] tracker for deduplication.
        resize_tmux: Whether to resize the tmux window.
        backpressure: Optional controller for flow control.
        websocket: WebSocket for sending responses (scroll pages).
        capabilities: Mutable list populated from client's initial resize.

    Returns:
        (cols, rows) tuple if this was a resize event, None otherwise
    """
    if "text" in message:
        return await _handle_text_message(
            message["text"], master_fd, session_id, tmux_session_name,
            last_resize, resize_tmux, backpressure, websocket, capabilities, recorder,
        )

    if "bytes" in message:
        return await _handle_binary_message(
            message["bytes"], master_fd, session_id, tmux_session_name,
            last_resize, resize_tmux, backpressure, websocket, capabilities, recorder,
        )

    return None
