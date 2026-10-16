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
    from ...services.tmux_control import ControlTerminal

logger = get_logger(__name__)

MAX_SCROLL_PAGE_SIZE = 5000
_CLAIM_ATTEMPTS = 5
_CLAIM_RETRY_SECONDS = 0.1
# Tether resize-claim refusals worth retrying; every other reason is permanent.
_CLAIM_RETRYABLE = frozenset({"client_not_attached", "tmux_unavailable"})


@dataclass
class ViewContext:
    """One WebSocket view of a session: its PTY, tmux target and claim identity.

    A control-mode view has no PTY (``master_fd`` -1): ``control`` is its tmux
    control client, set once the view's first size is known.
    """

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
    control: ControlTerminal | None = None
    # A claim asked for before the control client existed (no pid to claim with).
    pending_claim: bool = False

    @property
    def is_control(self) -> bool:
        return self.master_fd < 0


def _clamp_dimension(value: int, min_val: int, max_val: int) -> int:
    """Clamp a dimension value between min and max."""
    return min(max(value, min_val), max_val)


def _as_int(value: Any) -> int | None:
    """``int(value)``, or None when a client sent something that is not a number."""
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _ignore_malformed(view: ViewContext, field: str) -> None:
    logger.warning("a_term_malformed_ctrl_ignored", session_id=view.session_id, field=field)


def _extract_capabilities(data: dict[str, Any], capabilities: list[str]) -> None:
    """Populate capabilities list from control message, if present."""
    caps = data.get("capabilities")
    if isinstance(caps, list):
        capabilities.clear()
        capabilities.extend(str(cap) for cap in caps)


def _reread_generation(view: ViewContext) -> bool:
    from ...tether import TetherError, TetherUnavailable, get_client

    try:
        generation = get_client().get_session(view.session_id).get("generation")
    except (TetherError, TetherUnavailable):
        return False
    if not isinstance(generation, str):
        return False
    view.generation = generation
    return True


def _claim_tether_size(view: ViewContext, cols: int, rows: int) -> bool:
    """Ask Tether to size the shared window to this view's tmux client.

    The PTY's child is the tmux client, so its pid is the ``clientPid``.
    Right after connect the client may not be attached yet, so the retryable
    refusals (``client_not_attached``, ``tmux_unavailable``) are retried
    briefly. A changed generation (``409 stale_generation`` or reason
    ``stale``) is re-read once. Permanent refusals (``window_linked``,
    ``status_row``, ``invalid``) end the claim at once. A claim is never forced.
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
                if not _reread_generation(view):
                    return False
                continue
            logger.info("a_term_resize_claim_refused", session_id=view.session_id, code=error.code)
            return False
        except TetherUnavailable:
            logger.info("a_term_resize_claim_unavailable", session_id=view.session_id)
            return False
        if result.get("applied"):
            return True
        reason = result.get("reason")
        if reason == "stale" and not refreshed:
            refreshed = True
            if not _reread_generation(view):
                return False
            continue
        if reason in _CLAIM_RETRYABLE and attempt + 1 < _CLAIM_ATTEMPTS:
            time.sleep(_CLAIM_RETRY_SECONDS)
            continue
        logger.info("a_term_resize_claim_not_applied", session_id=view.session_id, reason=reason)
        return False
    return False


def _claim_window_size(view: ViewContext, cols: int, rows: int) -> bool:
    if view.kind == "tether":
        return _claim_tether_size(view, cols, rows)
    if view.kind == "legacy" and is_managed_tmux_session_name(view.tmux_session_name):
        return resize_tmux_window(view.tmux_session_name, cols, rows)
    # The user's own sessions: only this view's PTY follows the browser.
    return False


async def _handle_resize_command(data: dict[str, Any], view: ViewContext) -> tuple[int, int] | None:
    """Resize this view's PTY; claim the shared window only when asked.

    The frontend's active view (visible, focused, connected) sends ``claim:
    true`` on activation and with every settled size change, because a claim
    sets tmux's ``window-size`` to manual and the window then ignores later
    client sizes. A resize without ``claim`` only changes this view's client.
    A malformed size is ignored.
    """
    resize = data.get("resize")
    if not isinstance(resize, dict):
        _ignore_malformed(view, "resize")
        return None
    cols = _as_int(resize.get("cols", TMUX_DEFAULT_COLS))
    rows = _as_int(resize.get("rows", TMUX_DEFAULT_ROWS))
    if cols is None or rows is None:
        _ignore_malformed(view, "resize")
        return None
    cols = _clamp_dimension(cols, TMUX_MIN_COLS, TMUX_MAX_COLS)
    rows = _clamp_dimension(rows, TMUX_MIN_ROWS, TMUX_MAX_ROWS)

    if cols != view.last_resize[0] or rows != view.last_resize[1]:
        if view.control is not None:
            view.control.resize(cols, rows)
        elif not view.is_control:
            resize_pty(view.master_fd, cols, rows)
        view.last_resize[0] = cols
        view.last_resize[1] = rows
        logger.info("a_term_resized", session_id=view.session_id, cols=cols, rows=rows)

    if data.get("claim") is True:
        if view.is_control and view.control is None:
            view.pending_claim = True
        else:
            await asyncio.to_thread(_claim_window_size, view, cols, rows)

    return (cols, rows)


async def _handle_scroll_request(data: dict[str, Any], view: ViewContext) -> None:
    """Handle a scroll_request control message — return a scrollback page.

    A malformed request is ignored.
    """
    websocket, tmux_session_name, tmux_socket_name = view.websocket, view.tmux_session_name, view.tmux_socket
    req = data.get("scroll_request")
    if not isinstance(req, dict):
        _ignore_malformed(view, "scroll_request")
        return
    count = _as_int(req.get("count", 100))
    latest = "from_line" not in req
    from_line = 0 if latest else _as_int(req["from_line"])
    if count is None or from_line is None:
        _ignore_malformed(view, "scroll_request")
        return
    count = min(count, MAX_SCROLL_PAGE_SIZE)

    if not tmux_session_name or websocket is None:
        return

    from ...services.scrollback_pager import get_scrollback_line_count, get_scrollback_range

    # "Latest" mode: when from_line is omitted, fetch the most recent lines
    if latest:
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


async def _write_input(view: ViewContext, data: bytes) -> None:
    """Send typed input to the session: send-keys on control views, else the PTY."""
    if view.is_control:
        if view.control is not None:
            view.control.write(data)
        return
    await asyncio.to_thread(os.write, view.master_fd, data)


async def _handle_paste(text: Any, view: ViewContext) -> None:
    """Paste text. Control views paste through tmux, which brackets it only
    when the program enabled bracketed paste; PTY views get it bracketed."""
    if not isinstance(text, str) or not text:
        return
    if view.control is not None:
        await view.control.paste(text)
    elif not view.is_control:
        await _write_input(view, f"\x1b[200~{text}\x1b[201~".encode())


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
        if view.is_control:
            if view.control is not None:
                view.control.reseed()
            return None
        await asyncio.to_thread(os.write, view.master_fd, b"\x0c")
        logger.debug("a_term_refreshed", session_id=view.session_id)
        return None

    if "paste" in data:
        await _handle_paste(data.get("paste"), view)
        return None

    if "commit" in data and view.backpressure is not None:
        committed = _as_int(data["commit"])
        if committed is None:
            _ignore_malformed(view, "commit")
        else:
            view.backpressure.record_commit(committed)
        return None

    if "scroll_request" in data and view.websocket is not None:
        await _handle_scroll_request(data, view)
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
        except ValueError:
            # JSONDecodeError, plus the plain ValueError json raises for an
            # integer past Python's digit limit: either way it is not a
            # control message, so it is input like any other text.
            await _write_input(view, text.encode("utf-8"))
            return None
        if isinstance(data, dict) and data.get("__ctrl"):
            return await _handle_ctrl_message(data, view)

    await _write_input(view, text.encode("utf-8"))
    return None


async def _handle_binary_message(raw: bytes, view: ViewContext) -> tuple[int, int] | None:
    """Handle a binary message via the framed binary protocol."""
    if len(raw) > 1:
        from ...services.binary_protocol import MSG_CONTROL, MSG_INPUT, decode_client_message

        msg_type, payload = decode_client_message(raw)
        if msg_type == MSG_INPUT:
            await _write_input(view, payload)
            return None
        if msg_type == MSG_CONTROL:
            try:
                return await _handle_text_message(payload.decode("utf-8"), view)
            except UnicodeDecodeError:
                pass

    # Legacy binary: forward raw bytes to the PTY
    await _write_input(view, raw)
    return None


async def handle_websocket_message(message: Any, view: ViewContext) -> tuple[int, int] | None:
    """Handle one WebSocket message. Returns (cols, rows) for a resize event."""
    if message.get("text") is not None:
        return await _handle_text_message(message["text"], view)
    if message.get("bytes") is not None:
        return await _handle_binary_message(message["bytes"], view)
    return None
