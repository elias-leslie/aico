"""WebSocket connection lifecycle management.

Includes connection setup, heartbeat, resize negotiation, process cleanup,
and the main message loop — all stages of the WebSocket lifecycle.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal

from fastapi import WebSocket, WebSocketDisconnect

from ...constants import SHELL_MODE
from ...logging_config import get_logger
from ...services._pty_reader import _make_on_readable
from ...services.backpressure import BackpressureController
from ...services.diagnostics import get_registry as get_diagnostics_registry
from ...services.metrics import get_metrics
from ...services.pty_manager import read_pty_output, spawn_pty_for_tmux
from ...services.recording import SessionRecorder
from ...services.scrollback_pager import (
    get_viewport_lines,
)
from ...services.scrollback_sync import (
    LineDiffTracker,
    ScrollbackSyncOutputTracker,
    ScrollbackSyncScheduler,
    build_scrollback_sync_payload,
    prepare_scrollback_for_transport,
)
from ...utils.tmux import (
    apply_external_attach_options,
    get_cursor_position,
    get_scrollback,
    get_scrollback_with_cursor,
    reset_tmux_window_size_policy,
    restore_external_attach_options,
)
from .session_validation import validate_and_prepare_session
from .websocket_messages import handle_websocket_message

logger = get_logger(__name__)
SCROLLBACK_SYNC_MIN_LINES = 40


# ---------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------

async def _heartbeat_loop(websocket: WebSocket) -> None:
    """Send periodic heartbeat to keep connection alive through proxies."""
    while True:
        await asyncio.sleep(30)
        try:
            await websocket.send_bytes(b"\x00")
        except Exception:
            break


# ---------------------------------------------------------------------------
# Resize negotiation
# ---------------------------------------------------------------------------

async def _poll_for_resize(
    websocket: WebSocket,
    master_fd: int,
    session_id: str,
    tmux_session_name: str,
    resize_tmux: bool,
    capabilities: list[str] | None = None,
) -> bool:
    """Poll WebSocket messages until a resize event is received or disconnected."""
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return False
        resize_result = await handle_websocket_message(
            message,
            master_fd,
            session_id,
            tmux_session_name,
            resize_tmux=resize_tmux,
            capabilities=capabilities,
        )
        if resize_result is not None:
            logger.info(
                "initial_resize_received",
                session_id=session_id,
                cols=resize_result[0],
                rows=resize_result[1],
            )
            return True


async def _wait_for_initial_resize(
    websocket: WebSocket,
    master_fd: int,
    session_id: str,
    tmux_session_name: str,
    resize_tmux: bool = True,
    timeout: float = 5.0,
    capabilities: list[str] | None = None,
) -> bool:
    """Wait for initial resize event from frontend (syncs a_term dimensions)."""
    try:
        return await asyncio.wait_for(
            _poll_for_resize(
                websocket,
                master_fd,
                session_id,
                tmux_session_name,
                resize_tmux,
                capabilities,
            ),
            timeout=timeout,
        )
    except TimeoutError:
        logger.warning(
            "initial_resize_timeout",
            session_id=session_id,
            timeout=timeout,
        )
        return False


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

async def _wait_for_process(pid: int, max_iterations: int) -> bool:
    """Wait for a process to exit via non-blocking waitpid."""
    for _ in range(max_iterations):
        try:
            wpid, _ = os.waitpid(pid, os.WNOHANG)
            if wpid != 0:
                return True
        except (ChildProcessError, OSError):
            return True
        await asyncio.sleep(0.01)
    return False


async def _escalate_to_sigkill(pid: int) -> None:
    """Send SIGKILL and do a final blocking wait after SIGTERM timed out."""
    with contextlib.suppress(OSError):
        os.kill(pid, signal.SIGKILL)
    if not await _wait_for_process(pid, max_iterations=20):
        with contextlib.suppress(OSError, ChildProcessError):
            await asyncio.to_thread(os.waitpid, pid, 0)


async def _cleanup_pty_process(pid: int, master_fd: int) -> None:
    """Clean up PTY child process and file descriptor."""
    with contextlib.suppress(OSError):
        os.kill(pid, signal.SIGTERM)
    if not await _wait_for_process(pid, max_iterations=50):
        await _escalate_to_sigkill(pid)
    with contextlib.suppress(OSError):
        os.close(master_fd)


async def _cleanup_tasks(*tasks: asyncio.Task[object]) -> None:
    """Cancel and await multiple asyncio tasks."""
    for task in tasks:
        task.cancel()
    for task in tasks:
        with contextlib.suppress(asyncio.CancelledError):
            await task


# ---------------------------------------------------------------------------
# Initial scrollback helpers
# ---------------------------------------------------------------------------

async def _send_viewport_init(
    websocket: WebSocket,
    session_id: str,
    tmux_session_name: str,
) -> None:
    """Send viewport_init control message for demand-paging clients."""
    viewport_result = await asyncio.to_thread(
        get_viewport_lines, tmux_session_name, 50,
    )
    if not viewport_result:
        return
    viewport_text, total_lines, viewport_start = viewport_result
    cursor_position = await asyncio.to_thread(get_cursor_position, tmux_session_name)
    viewport_init: dict = {
        "lines": viewport_text,
        "total_lines": total_lines,
        "viewport_start_line": viewport_start,
    }
    if cursor_position:
        viewport_init["cursor_position"] = {
            "x": cursor_position[0],
            "y": cursor_position[1],
        }
    await websocket.send_text(json.dumps({"__ctrl": True, "viewport_init": viewport_init}))
    logger.info("viewport_init_sent", session_id=session_id, total_lines=total_lines)


async def _send_shell_legacy_scrollback(
    websocket: WebSocket,
    session_id: str,
    tmux_session_name: str,
) -> None:
    """Send full scrollback snapshot for shell sessions without demand-paging."""
    scrollback, cursor_position = await asyncio.to_thread(
        get_scrollback_with_cursor, tmux_session_name,
    )
    if not scrollback:
        return
    prepared_scrollback = prepare_scrollback_for_transport(scrollback)
    if not prepared_scrollback:
        return
    await websocket.send_text(
        build_scrollback_sync_payload(scrollback, cursor_position),
    )
    logger.info(
        "scrollback_sent",
        session_id=session_id,
        bytes=len(prepared_scrollback),
        original_bytes=len(scrollback),
    )


async def _send_tui_prefetch_scrollback(
    websocket: WebSocket,
    session_id: str,
    tmux_session_name: str,
) -> None:
    """Pre-populate overlay cache for TUI/agent sessions on connect."""
    scrollback_raw = await asyncio.to_thread(get_scrollback, tmux_session_name)
    if not scrollback_raw:
        return
    sb_lines = scrollback_raw.split("\n")
    # Strip trailing empties from capture-pane output
    while sb_lines and sb_lines[-1] == "":
        sb_lines.pop()
    if not sb_lines:
        return
    page_payload: dict = {
        "__ctrl": True,
        "scrollback_page": {
            "from_line": 0,
            "lines": sb_lines,
            "total_lines": len(sb_lines),
        },
    }
    await websocket.send_text(json.dumps(page_payload))
    logger.info(
        "tui_scrollback_prefetch_sent",
        session_id=session_id,
        lines_sent=len(sb_lines),
    )


# ---------------------------------------------------------------------------
# Session service factories
# ---------------------------------------------------------------------------

def _create_backpressure_controller(
    master_fd: int,
    session_id: str,
    capabilities: list[str],
) -> BackpressureController | None:
    """Create backpressure controller when the client supports it."""
    if "backpressure" not in capabilities:
        return None
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=256)
    on_readable_cb = _make_on_readable(master_fd, queue, session_id=session_id)
    return BackpressureController(loop, master_fd, on_readable_cb)


def _create_session_recorder(session_id: str) -> SessionRecorder | None:
    """Create and start session recorder if recording is enabled in config."""
    from ...config import get_settings as _get_settings
    cfg = _get_settings()
    if not cfg.recording_enabled:
        return None
    recorder = SessionRecorder(
        session_id,
        recording_dir=cfg.recording_dir,
        max_size_bytes=cfg.recording_max_size_mb * 1024 * 1024,
    )
    recorder.start()
    return recorder


def _create_scrollback_sync(
    websocket: WebSocket,
    tmux_session_name: str,
    capabilities: list[str],
    diag: object,
    recorder: SessionRecorder | None,
) -> tuple[ScrollbackSyncScheduler, ScrollbackSyncOutputTracker]:
    """Create scrollback sync scheduler and tracker for the session."""
    use_binary = "binary_protocol" in capabilities
    diff_tracker = LineDiffTracker() if "diff_sync" in capabilities else None
    scrollback_sync = ScrollbackSyncScheduler(
        websocket,
        tmux_session_name,
        use_binary=use_binary,
        diff_tracker=diff_tracker,
        diag=diag,
    )
    scrollback_tracker = ScrollbackSyncOutputTracker(
        scrollback_sync,
        min_lines=SCROLLBACK_SYNC_MIN_LINES,
    )
    scrollback_sync.set_output_tracker(scrollback_tracker)
    if recorder is not None:
        scrollback_sync.set_recorder(recorder)
    return scrollback_sync, scrollback_tracker


def _make_output_flush_callback(
    a_term_metrics: object,
    scrollback_tracker: ScrollbackSyncOutputTracker | None,
    recorder: SessionRecorder | None,
):
    """Build the on_flush callback for PTY output processing."""
    async def on_flush(batch: str) -> None:
        a_term_metrics.inc("flush_count")  # type: ignore[union-attr]
        a_term_metrics.inc("total_bytes_flushed", len(batch.encode("utf-8")))  # type: ignore[union-attr]
        a_term_metrics.inc("messages_sent")  # type: ignore[union-attr]
        if scrollback_tracker:
            scrollback_tracker.record_output(batch)
        if recorder is not None:
            recorder.record_output(batch)
    return on_flush


async def _teardown_session_resources(
    session: dict,
    tmux_session_name: str,
    session_id: str,
    backpressure: BackpressureController | None,
    scrollback_sync: ScrollbackSyncScheduler | None,
    recorder: SessionRecorder | None,
    diag_registry: object,
    a_term_metrics: object,
) -> None:
    """Close and clean up all resources allocated during session setup."""
    if backpressure:
        backpressure.close()
    if scrollback_sync:
        await scrollback_sync.close()
    if recorder is not None:
        await recorder.stop()
    diag_registry.remove(session_id)  # type: ignore[union-attr]
    a_term_metrics.dec("active_connections")  # type: ignore[union-attr]
    a_term_metrics.dec("active_sessions")  # type: ignore[union-attr]
    if session.get("is_external"):
        await asyncio.to_thread(restore_external_attach_options, tmux_session_name)
        await asyncio.to_thread(reset_tmux_window_size_policy, tmux_session_name)


# ---------------------------------------------------------------------------
# Connection lifecycle
# ---------------------------------------------------------------------------

async def _setup_connection(
    websocket: WebSocket,
    session_id: str,
    capabilities: list[str],
) -> tuple[dict, str, int, int, bool]:
    """Validate session, spawn PTY, sync dimensions and send scrollback.

    Returns:
        (session, tmux_session_name, master_fd, pid, resize_tmux)

    Raises:
        ValueError: if the session is invalid/dead (caller closes websocket)
    """
    session, tmux_session_name = await asyncio.to_thread(
        validate_and_prepare_session, session_id
    )
    resize_tmux = not bool(session.get("is_external"))
    external_attach_applied = False
    try:
        if session.get("is_external"):
            await asyncio.to_thread(reset_tmux_window_size_policy, tmux_session_name)
            external_attach_applied = await asyncio.to_thread(
                apply_external_attach_options,
                tmux_session_name,
            )

        stored_target_session = session.get("last_claude_session")
        master_fd, pid = spawn_pty_for_tmux(tmux_session_name, stored_target_session)
        await _wait_for_initial_resize(
            websocket, master_fd, session_id, tmux_session_name,
            resize_tmux=resize_tmux, capabilities=capabilities,
        )

        is_shell = session.get("mode") == SHELL_MODE
        if is_shell:
            if "demand_paging" in capabilities:
                await _send_viewport_init(websocket, session_id, tmux_session_name)
            else:
                await _send_shell_legacy_scrollback(websocket, session_id, tmux_session_name)
        else:
            await _send_tui_prefetch_scrollback(websocket, session_id, tmux_session_name)

        return session, tmux_session_name, master_fd, pid, resize_tmux
    except Exception:
        if external_attach_applied:
            await asyncio.to_thread(restore_external_attach_options, tmux_session_name)
        if session.get("is_external"):
            await asyncio.to_thread(reset_tmux_window_size_policy, tmux_session_name)
        raise


async def _run_message_loop(
    websocket: WebSocket,
    master_fd: int,
    session_id: str,
    tmux_session_name: str,
    resize_tmux: bool,
    output_task: asyncio.Task,
    heartbeat_task: asyncio.Task,
    backpressure: BackpressureController | None = None,
    capabilities: list[str] | None = None,
    recorder: SessionRecorder | None = None,
) -> None:
    """Process incoming WebSocket messages until disconnect."""
    metrics = get_metrics()
    last_resize = [0, 0]
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            metrics.inc("messages_received")
            result = await handle_websocket_message(
                message,
                master_fd,
                session_id,
                tmux_session_name,
                last_resize,
                resize_tmux=resize_tmux,
                backpressure=backpressure,
                websocket=websocket,
                capabilities=capabilities,
                recorder=recorder,
            )
            # Record resize events
            if result is not None and recorder is not None:
                recorder.record_resize(result[0], result[1])
    except WebSocketDisconnect:
        logger.info("a_term_disconnected", session_id=session_id)
    finally:
        await _cleanup_tasks(heartbeat_task, output_task)


async def _run_session(
    websocket: WebSocket,
    session_id: str,
) -> tuple[int | None, int | None]:
    """Set up and run the full a_term session. Returns (pid, master_fd) for cleanup."""
    capabilities: list[str] = []
    try:
        session, tmux_session_name, master_fd, pid, resize_tmux = await _setup_connection(
            websocket, session_id, capabilities
        )
    except ValueError as e:
        await websocket.close(
            code=4000,
            reason=json.dumps({"error": "session_dead", "message": str(e)}),
        )
        return None, None

    use_binary = "binary_protocol" in capabilities
    backpressure = _create_backpressure_controller(master_fd, session_id, capabilities)
    diag_registry = get_diagnostics_registry()
    diag = diag_registry.get_or_create(session_id)
    a_term_metrics = get_metrics()
    a_term_metrics.inc("active_connections")
    a_term_metrics.inc("active_sessions")
    a_term_metrics.inc("total_sessions_created")
    recorder = _create_session_recorder(session_id)
    scrollback_sync, scrollback_tracker = _create_scrollback_sync(
        websocket, tmux_session_name, capabilities, diag, recorder
    )
    on_flush = _make_output_flush_callback(a_term_metrics, scrollback_tracker, recorder)
    output_task = asyncio.create_task(
        read_pty_output(
            websocket, master_fd, session_id=session_id,
            on_flush=on_flush, backpressure=backpressure,
            use_binary=use_binary, diag=diag,
        )
    )
    heartbeat_task = asyncio.create_task(_heartbeat_loop(websocket))
    try:
        await _run_message_loop(
            websocket, master_fd, session_id, tmux_session_name, resize_tmux,
            output_task, heartbeat_task,
            backpressure=backpressure, capabilities=capabilities, recorder=recorder,
        )
    finally:
        await _teardown_session_resources(
            session, tmux_session_name, session_id, backpressure,
            scrollback_sync, recorder, diag_registry, a_term_metrics,
        )
    return pid, master_fd


async def handle_a_term_connection(
    websocket: WebSocket,
    session_id: str,
) -> None:
    """Handle a a_term WebSocket connection.

    Protocol: text input, binary resize (JSON {cols, rows}), text output.
    """
    await websocket.accept()
    logger.info("a_term_connected", session_id=session_id)
    pid: int | None = None
    master_fd: int | None = None
    try:
        pid, master_fd = await _run_session(websocket, session_id)
    except Exception as e:
        logger.error("a_term_error", session_id=session_id, error=str(e))
        with contextlib.suppress(Exception):
            await websocket.close(code=1011, reason="Internal server error")
    finally:
        if pid is not None and master_fd is not None:
            await _cleanup_pty_process(pid, master_fd)
        logger.info("a_term_cleanup_complete", session_id=session_id)
