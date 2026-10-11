"""WebSocket message handling for one attached view."""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass, field
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
from ...utils.tmux import is_managed_tmux_session_name, resize_tmux_window

if TYPE_CHECKING:
    from fastapi import WebSocket

    from ...services.backpressure import BackpressureController

logger = get_logger(__name__)

MAX_SCROLL_PAGE_SIZE = 5000
_CLAIM_ATTEMPTS = 5
_CLAIM_RETRY_SECONDS = 0.1


@dataclass
class ViewContext:
    """One WebSocket view of a session: its PTY, tmux target and claim identity."""

    session_id: str
    master_fd: int
    tmux_session_name: str
    tmux_socket: str | None = None
    kind: str = "external"  # "tether" | "legacy" | "external"
    generation: str | None = None
    client_pid: int | None = None
    last_resize: list[int] = field(default_factory=lambda: [0, 0])
    capabilities: list[str] = field(default_factory=list)
    backpressure: BackpressureController | None = None
    websocket: WebSocket | None = None


def _clamp_dimension(value: int, min_val: int, max_val: int) -> int:
    """Clamp a dimension value between min and max."""
    return min(max(value, min_val), max_val)


def _extract_capabilities(data: dict[str, Any], capabilities: list[str]) -> None:
    """Populate capabilities list from control message, if present."""
    caps = data.get("capabilities")
    if isinstance(caps, list):
        capabilities.clear()
        capabilities.extend(str(cap) for cap in caps)


def _claim_tether_size(view: ViewContext, cols: int, rows: int) -> bool:
    """Ask Tether to size the shared window to this view's tmux client.

    The PTY's child is the tmux client, so its pid is the ``clientPid``. The
    client may not be attached yet right after connect, so a refused claim is
    retried briefly. A stale generation is re-read once; a claim is never
    forced.
    """
    from ...tether import TetherError, TetherUnavailable, get_client

    if not view.generation or view.client_pid is None:
        return False
    client = get_client()
    refreshed = False
    for attempt in range(_CLAIM_ATTEMPTS):
        try:
            result = client.resize_claim(view.session_id, view.generation, view.client_pid, cols, rows)
        except TetherError as error:
            if error.code == "stale_generation" and not refreshed:
                refreshed = True
                try:
                    generation = client.get_session(view.session_id).get("generation")
                except (TetherError, TetherUnavailable):
                    return False
                if not isinstance(generation, str):
                    return False
                view.generation = generation
                continue
            logger.info("a_term_resize_claim_refused", session_id=view.session_id, code=error.code)
            return False
        except TetherUnavailable:
            logger.info("a_term_resize_claim_unavailable", session_id=view.session_id)
            return False
        if result.get("applied"):
            return True
        if attempt + 1 < _CLAIM_ATTEMPTS:
            time.sleep(_CLAIM_RETRY_SECONDS)
        else:
            logger.info("a_term_resize_claim_not_applied", session_id=view.session_id, reason=result.get("reason"))
    return False


def _claim_window_size(view: ViewContext, cols: int, rows: int) -> bool:
    if view.kind == "tether":
        return _claim_tether_size(view, cols, rows)
    if view.kind == "legacy" and is_managed_tmux_session_name(view.tmux_session_name):
        return resize_tmux_window(view.tmux_session_name, cols, rows)
    # The user's own sessions: only this view's PTY follows the browser.
    return False


async def _handle_resize_command(data: dict[str, Any], view: ViewContext) -> tuple[int, int]:
    """Resize this view's PTY; claim the shared window only when asked.

    The frontend sends ``claim: true`` when the view becomes active (visible,
    focused, connected). Other resizes only change this view's own client.
    """
    resize = data.get("resize", {})
    cols = _clamp_dimension(int(resize.get("cols", TMUX_DEFAULT_COLS)), TMUX_MIN_COLS, TMUX_MAX_COLS)
    rows = _clamp_dimension(int(resize.get("rows", TMUX_DEFAULT_ROWS)), TMUX_MIN_ROWS, TMUX_MAX_ROWS)

    if cols != view.last_resize[0] or rows != view.last_resize[1]:
        resize_pty(view.master_fd, cols, rows)
        view.last_resize[0] = cols
        view.last_resize[1] = rows
        logger.info("a_term_resized", session_id=view.session_id, cols=cols, rows=rows)

    if data.get("claim") is True:
        await asyncio.to_thread(_claim_window_size, view, cols, rows)

    return (cols, rows)


async def _handle_scroll_request(
    data: dict[str, Any],
    websocket: WebSocket,
    tmux_session_name: str | None,
    tmux_socket_name: str | None,
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
        total = await asyncio.to_thread(
            get_scrollback_line_count,
            tmux_session_name,
            tmux_socket_name,
        )
        if total is None:
            return
        from_line = max(0, total - count)

    result = await asyncio.to_thread(
        get_scrollback_range,
        tmux_session_name,
        from_line,
        count,
        tmux_socket_name,
    )
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


async def _handle_pane_mode_request(
    websocket: WebSocket,
    tmux_session_name: str | None,
    tmux_socket_name: str | None,
) -> None:
    """Answer a pane_mode_request — who owns this pane's scrollback.

    A full-screen TUI that grabs the mouse (Claude Code) keeps its transcript
    itself and tmux stores no history for it, so the client hands it the wheel
    instead of opening the scrollback overlay on an empty history.
    """
    if not tmux_session_name or websocket is None:
        return

    from ...services.scrollback_pager import get_pane_mode

    mode = await asyncio.to_thread(get_pane_mode, tmux_session_name, tmux_socket_name)
    if mode is None:
        return

    alternate_screen, mouse_reporting = mode
    payload = {
        "__ctrl": True,
        "pane_mode": {
            "alternate_screen": alternate_screen,
            "mouse_reporting": mouse_reporting,
        },
    }
    await websocket.send_text(json.dumps(payload))


async def _handle_ctrl_message(data: dict[str, Any], view: ViewContext) -> tuple[int, int] | None:
    """Dispatch a validated __ctrl message to the appropriate handler."""
    if "resize" in data:
        _extract_capabilities(data, view.capabilities)
        return await _handle_resize_command(data, view)

    if "capabilities" in data:
        _extract_capabilities(data, view.capabilities)
        return None

    if data.get("ping"):
        return None

    if "renderer_status" in data:
        status = data.get("renderer_status")
        if isinstance(status, dict):
            logger.info(
                "a_term_renderer_status",
                session_id=view.session_id,
                renderer=status.get("renderer"),
                webgl_context_available=status.get("webglContextAvailable"),
                webgl2_context_available=status.get("webgl2ContextAvailable"),
                webgl_addon_loaded=status.get("webglAddonLoaded"),
                canvas_count=status.get("canvasCount"),
                term_class_name=status.get("termClassName"),
                user_agent=status.get("userAgent"),
            )
        return None

    if data.get("refresh"):
        await asyncio.to_thread(os.write, view.master_fd, b"\x0c")
        logger.debug("a_term_refreshed", session_id=view.session_id)
        return None

    if "commit" in data and view.backpressure is not None:
        view.backpressure.record_commit(int(data["commit"]))
        return None

    if "scroll_request" in data and view.websocket is not None:
        await _handle_scroll_request(data, view.websocket, view.tmux_session_name, view.tmux_socket)
        return None

    if data.get("pane_mode_request") and view.websocket is not None:
        await _handle_pane_mode_request(view.websocket, view.tmux_session_name, view.tmux_socket)
        return None

    return None


async def _handle_text_message(text: str, view: ViewContext) -> tuple[int, int] | None:
    """Handle a text message: a JSON control message or raw input.

    Control messages must include '__ctrl': true to distinguish them from
    user-typed JSON that happens to match control message structure.
    """
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            await asyncio.to_thread(os.write, view.master_fd, text.encode("utf-8"))
            return None
        if isinstance(data, dict) and data.get("__ctrl"):
            return await _handle_ctrl_message(data, view)

    await asyncio.to_thread(os.write, view.master_fd, text.encode("utf-8"))
    return None


async def _handle_binary_message(raw: bytes, view: ViewContext) -> tuple[int, int] | None:
    """Handle a binary message via the framed binary protocol."""
    if len(raw) > 1:
        from ...services.binary_protocol import MSG_CONTROL, MSG_INPUT, decode_client_message

        msg_type, payload = decode_client_message(raw)
        if msg_type == MSG_INPUT:
            await asyncio.to_thread(os.write, view.master_fd, payload)
            return None
        if msg_type == MSG_CONTROL:
            try:
                return await _handle_text_message(payload.decode("utf-8"), view)
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass

    # Legacy binary: forward raw bytes to the PTY
    await asyncio.to_thread(os.write, view.master_fd, raw)
    return None


async def handle_websocket_message(message: Any, view: ViewContext) -> tuple[int, int] | None:
    """Handle one WebSocket message. Returns (cols, rows) for a resize event."""
    if message.get("text") is not None:
        return await _handle_text_message(message["text"], view)
    if message.get("bytes") is not None:
        return await _handle_binary_message(message["bytes"], view)
    return None
