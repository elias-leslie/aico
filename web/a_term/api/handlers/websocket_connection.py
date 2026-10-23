"""WebSocket connection lifecycle management.

Includes connection setup, heartbeat, resize negotiation, task cleanup,
and the main message loop — all stages of the WebSocket lifecycle.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from collections.abc import Callable

from fastapi import WebSocket, WebSocketDisconnect

from ...config import TMUX_DEFAULT_COLS, TMUX_DEFAULT_ROWS
from ...logging_config import get_logger
from ...services._output_batch import _run_batch_loop
from ...services.diagnostics import get_registry as get_diagnostics_registry
from ...services.metrics import get_metrics
from ...services.tmux_control import SEED_HISTORY_LINES, ControlTerminal, attach_environment
from ...utils.tmux import apply_external_attach_options, restore_external_attach_options
from .session_validation import AttachPlan, validate_and_prepare_session
from .websocket_messages import ViewContext, _claim_window_size, handle_websocket_message

logger = get_logger(__name__)


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

async def _poll_for_resize(websocket: WebSocket, view: ViewContext) -> bool:
    """Poll WebSocket messages until a resize event is received or disconnected."""
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return False
        resize_result = await handle_websocket_message(message, view)
        if resize_result is not None:
            logger.info(
                "initial_resize_received",
                session_id=view.session_id,
                cols=resize_result[0],
                rows=resize_result[1],
            )
            return True
        if view.capabilities:
            return True


async def _wait_for_initial_resize(websocket: WebSocket, view: ViewContext, timeout: float = 5.0) -> bool:
    """Wait for the frontend's first resize so the PTY matches the browser."""
    try:
        return await asyncio.wait_for(_poll_for_resize(websocket, view), timeout=timeout)
    except TimeoutError:
        logger.warning("initial_resize_timeout", session_id=view.session_id, timeout=timeout)
        return False


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

async def _cleanup_tasks(*tasks: asyncio.Task[object]) -> None:
    """Cancel and await multiple asyncio tasks."""
    for task in tasks:
        task.cancel()
    for task in tasks:
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def _call_tmux_session_fn(
    fn: Callable[..., object],
    tmux_session_name: str,
    tmux_socket_name: str | None,
) -> object:
    if tmux_socket_name:
        return await asyncio.to_thread(fn, tmux_session_name, tmux_socket_name)
    return await asyncio.to_thread(fn, tmux_session_name)


# ---------------------------------------------------------------------------
# Session services
# ---------------------------------------------------------------------------

def _make_output_flush_callback(a_term_metrics: object):
    """Build the on_flush callback that counts flushed output."""
    async def on_flush(batch: str) -> None:
        a_term_metrics.inc("flush_count")  # type: ignore[union-attr]
        a_term_metrics.inc("total_bytes_flushed", len(batch.encode("utf-8")))  # type: ignore[union-attr]
        a_term_metrics.inc("messages_sent")  # type: ignore[union-attr]
    return on_flush


async def _teardown_session_resources(
    plan: AttachPlan,
    session_id: str,
    diag_registry: object,
    a_term_metrics: object,
) -> None:
    """Release the view's diagnostics, metrics and external attach options."""
    diag_registry.remove(session_id)  # type: ignore[union-attr]
    a_term_metrics.dec("active_connections")  # type: ignore[union-attr]
    a_term_metrics.dec("active_sessions")  # type: ignore[union-attr]
    if plan.kind == "external":
        await _call_tmux_session_fn(
            restore_external_attach_options,
            plan.tmux_session_name,
            plan.tmux_socket,
        )


# ---------------------------------------------------------------------------
# Connection lifecycle
# ---------------------------------------------------------------------------

async def _send_transport(websocket: WebSocket) -> None:
    """Tell the browser how much history the seed carries."""
    await websocket.send_text(
        json.dumps({"__ctrl": True, "transport": "control", "history_lines": SEED_HISTORY_LINES})
    )


async def _setup_connection(websocket: WebSocket, session_id: str) -> tuple[AttachPlan, ViewContext]:
    """Resolve the session and start a tmux control client once the view's first size is known.

    No scrollback is sent: the control client's seed carries the pane's
    history, screen and modes into the browser's own terminal. Raises
    ValueError if the session is gone or cannot be attached (the caller
    closes the WebSocket).
    """
    plan = await asyncio.to_thread(validate_and_prepare_session, session_id)
    external_attach_applied = False
    try:
        if plan.kind == "external":
            external_attach_applied = bool(
                await _call_tmux_session_fn(apply_external_attach_options, plan.tmux_session_name, plan.tmux_socket)
            )
        view = ViewContext(
            session_id=plan.session_id,
            tmux_session_name=plan.tmux_session_name,
            tmux_socket=plan.tmux_socket,
            kind=plan.kind,
            generation=plan.generation,
            websocket=websocket,
        )
        await _send_transport(websocket)
        await _wait_for_initial_resize(websocket, view)
        cols, rows = view.last_resize
        view.control = await ControlTerminal.start(
            plan.argv,
            plan.env if plan.sandbox else attach_environment(plan.env, plan.unset),
            cols or TMUX_DEFAULT_COLS,
            rows or TMUX_DEFAULT_ROWS,
            cwd=os.environ.get("HOME"),
            sized=bool(cols and rows),
            sandbox=plan.sandbox,
        )
        view.client_pid = view.control.client_pid
        if view.pending_claim:
            view.pending_claim = False
            await asyncio.to_thread(_claim_window_size, view, cols, rows)
        return plan, view
    except Exception:
        if external_attach_applied:
            await _call_tmux_session_fn(restore_external_attach_options, plan.tmux_session_name, plan.tmux_socket)
        raise


async def _run_message_loop(
    websocket: WebSocket,
    view: ViewContext,
    output_task: asyncio.Task,
    heartbeat_task: asyncio.Task,
) -> None:
    """Process incoming WebSocket messages until disconnect."""
    metrics = get_metrics()
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            metrics.inc("messages_received")
            await handle_websocket_message(message, view)
    except WebSocketDisconnect:
        logger.info("a_term_disconnected", session_id=view.session_id)
    finally:
        await _cleanup_tasks(heartbeat_task, output_task)


async def _run_session(websocket: WebSocket, session_id: str) -> None:
    """Set up and stream a view until the browser or tmux goes away.

    tmux paces the stream itself (pause-after), so there is no byte
    backpressure and no scrollback sync: history lives in the browser.
    """
    try:
        plan, view = await _setup_connection(websocket, session_id)
    except ValueError as e:
        await websocket.close(
            code=4000,
            reason=json.dumps({"error": "session_dead", "message": str(e)}),
        )
        return

    control = view.control
    assert control is not None
    diag_registry = get_diagnostics_registry()
    diag = diag_registry.get_or_create(session_id)
    a_term_metrics = get_metrics()
    a_term_metrics.inc("active_connections")
    a_term_metrics.inc("active_sessions")
    a_term_metrics.inc("total_sessions_created")
    output_task = asyncio.create_task(
        _run_batch_loop(
            websocket,
            control.queue,
            asyncio.get_running_loop(),
            _make_output_flush_callback(a_term_metrics),
            "binary_protocol" in view.capabilities,
            diag,
        )
    )
    heartbeat_task = asyncio.create_task(_heartbeat_loop(websocket))
    try:
        await _run_message_loop(websocket, view, output_task, heartbeat_task)
    finally:
        await control.close()
        await _teardown_session_resources(plan, session_id, diag_registry, a_term_metrics)


async def handle_a_term_connection(
    websocket: WebSocket,
    session_id: str,
) -> None:
    """Handle a a_term WebSocket connection.

    Protocol: text input, binary resize (JSON {cols, rows}), text output.
    """
    await websocket.accept()
    logger.info("a_term_connected", session_id=session_id)
    try:
        await _run_session(websocket, session_id)
    except Exception as e:
        logger.error("a_term_error", session_id=session_id, error=str(e))
        with contextlib.suppress(Exception):
            await websocket.close(code=1011, reason="Internal server error")
    finally:
        logger.info("a_term_cleanup_complete", session_id=session_id)
