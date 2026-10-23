"""WebSocket view setup: attach plan -> initial size -> tmux control client."""

from __future__ import annotations

import json
from contextlib import ExitStack
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from a_term.api.handlers.session_validation import AttachPlan
from a_term.api.handlers.websocket_connection import (
    _poll_for_resize,
    _run_session,
    _setup_connection,
    handle_a_term_connection,
)
from a_term.api.handlers.websocket_messages import ViewContext
from a_term.services.tmux_control import SEED_HISTORY_LINES

MODULE = "a_term.api.handlers.websocket_connection"
SOCKET = "/tmp/tether-test/tether/default/tmux/" + "a0000001" * 4 + "/server.sock"


def _plan(kind: str = "tether", mode: str = "codex", name: str = "tether-a0000001") -> AttachPlan:
    socket_path = SOCKET if kind == "tether" else None
    argv = (
        ["/usr/bin/tmux", "-S", SOCKET, "attach-session", "-t", "$1"]
        if kind == "tether"
        else ["tmux", "attach-session", "-t", name]
    )
    return AttachPlan(
        session={"id": "a0000001" if kind == "tether" else name, "mode": mode},
        kind=kind,
        tmux_session_name=name,
        tmux_socket=socket_path,
        argv=argv,
        env={"COLORTERM": "truecolor"} if kind == "tether" else {},
        generation="g" * 64 if kind == "tether" else None,
        sandbox=kind == "tether",
    )


def _control_terminal(pid: int = 31) -> MagicMock:
    control = MagicMock()
    control.pid = pid
    control.client_pid = pid + 1  # the sandbox forks: tmux is bwrap's child
    control.close = AsyncMock()
    return control


@pytest.mark.asyncio
async def test_initial_capabilities_complete_without_a_resize() -> None:
    websocket = AsyncMock()
    websocket.receive = AsyncMock(return_value={
        "type": "websocket.receive",
        "text": '{"__ctrl": true, "capabilities": ["binary_protocol"]}',
    })
    view = ViewContext(session_id="s", tmux_session_name="t")
    assert await _poll_for_resize(websocket, view) is True
    assert view.capabilities == ["binary_protocol"]


@pytest.mark.asyncio
async def test_disconnect_before_resize_ends_the_wait() -> None:
    websocket = AsyncMock()
    websocket.receive = AsyncMock(return_value={"type": "websocket.disconnect"})
    view = ViewContext(session_id="s", tmux_session_name="t")
    assert await _poll_for_resize(websocket, view) is False


@pytest.mark.asyncio
async def test_view_starts_after_the_first_size_and_then_claims() -> None:
    plan = _plan()
    websocket = AsyncMock()
    control = _control_terminal()

    async def fake_wait(_websocket, view, timeout=5.0):
        view.last_resize[:] = [100, 40]
        view.pending_claim = True
        return True

    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}._wait_for_initial_resize", new=fake_wait),
        patch(f"{MODULE}.ControlTerminal.start", new=AsyncMock(return_value=control)) as start,
        patch(f"{MODULE}._claim_window_size", return_value=True) as claim,
        patch(f"{MODULE}.apply_external_attach_options") as apply_options,
    ):
        result_plan, view = await _setup_connection(websocket, "a0000001")

    apply_options.assert_not_called()
    assert result_plan is plan
    assert start.await_args is not None
    args, kwargs = start.await_args
    assert args[0] == plan.argv and args[2:] == (100, 40)
    assert args[1] == plan.env  # exactly the sandbox environment, nothing inherited
    assert kwargs["sized"] is True and kwargs["sandbox"] is True
    assert (view.control, view.client_pid, view.kind) == (control, 32, "tether")  # tmux's pid claims the size
    assert view.generation == plan.generation
    assert view.tmux_socket == SOCKET
    claim.assert_called_once_with(view, 100, 40)
    assert view.pending_claim is False
    sent = [json.loads(call.args[0]) for call in websocket.send_text.await_args_list]
    # The browser sizes its history from this, so the seed always fits.
    assert {"__ctrl": True, "transport": "control", "history_lines": SEED_HISTORY_LINES} in sent


@pytest.mark.asyncio
async def test_view_without_a_size_starts_unsized() -> None:
    plan = _plan()
    control = _control_terminal()
    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}._wait_for_initial_resize", new=AsyncMock(return_value=True)),
        patch(f"{MODULE}.ControlTerminal.start", new=AsyncMock(return_value=control)) as start,
        patch(f"{MODULE}._claim_window_size") as claim,
    ):
        await _setup_connection(AsyncMock(), "a0000001")
    assert start.await_args is not None and start.await_args.kwargs["sized"] is False
    claim.assert_not_called()


@pytest.mark.asyncio
async def test_external_session_toggles_attach_options_on_its_server() -> None:
    plan = _plan(kind="external", name="codex-agent-hub")
    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.apply_external_attach_options", return_value=True) as apply_options,
        patch(f"{MODULE}._wait_for_initial_resize", new=AsyncMock()),
        patch(f"{MODULE}.ControlTerminal.start", new=AsyncMock(return_value=_control_terminal())),
    ):
        await _setup_connection(AsyncMock(), "codex-agent-hub")
    apply_options.assert_called_once_with("codex-agent-hub")


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", ["wait", "start"])
async def test_failed_setup_restores_options(fail: str) -> None:
    plan = _plan(kind="external", name="codex-agent-hub")
    wait = AsyncMock(side_effect=RuntimeError("boom")) if fail == "wait" else AsyncMock()
    start = AsyncMock(side_effect=OSError("no tmux")) if fail == "start" else AsyncMock()
    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.apply_external_attach_options", return_value=True),
        patch(f"{MODULE}.restore_external_attach_options", return_value=True) as restore,
        patch(f"{MODULE}._wait_for_initial_resize", new=wait),
        patch(f"{MODULE}.ControlTerminal.start", new=start),
        pytest.raises((RuntimeError, OSError)),
    ):
        await _setup_connection(AsyncMock(), "codex-agent-hub")
    restore.assert_called_once_with("codex-agent-hub")


@pytest.mark.asyncio
async def test_dead_session_closes_with_session_dead() -> None:
    websocket = AsyncMock()
    with patch(f"{MODULE}.validate_and_prepare_session", side_effect=ValueError("Session not found: x")):
        assert await _run_session(websocket, "x") is None
    websocket.close.assert_awaited_once()
    reason = json.loads(websocket.close.await_args.kwargs["reason"])
    assert reason == {"error": "session_dead", "message": "Session not found: x"}
    assert websocket.close.await_args.kwargs["code"] == 4000


def _view(plan: AttachPlan, control: MagicMock | None = None) -> ViewContext:
    return ViewContext(
        session_id=plan.session_id, tmux_session_name=plan.tmux_session_name,
        tmux_socket=plan.tmux_socket, kind=plan.kind, generation=plan.generation, client_pid=32,
        control=control or _control_terminal(),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["tether", "external"])
async def test_session_streams_its_queue_closes_the_client_and_restores_only_external_options(kind: str) -> None:
    plan = _plan(kind=kind, name="tether-a0000001" if kind == "tether" else "codex-agent-hub")
    control = _control_terminal()
    with (
        patch(f"{MODULE}._setup_connection", new=AsyncMock(return_value=(plan, _view(plan, control)))),
        patch(f"{MODULE}._run_message_loop", new=AsyncMock()),
        patch(f"{MODULE}._run_batch_loop", new=AsyncMock()) as batch,
        patch(f"{MODULE}._heartbeat_loop", new=AsyncMock()),
        patch(f"{MODULE}.restore_external_attach_options", return_value=True) as restore,
    ):
        await _run_session(AsyncMock(), plan.session_id)
    assert batch.call_args.args[1] is control.queue
    control.close.assert_awaited_once()
    if kind == "external":
        restore.assert_called_once_with("codex-agent-hub")
    else:
        restore.assert_not_called()


@pytest.mark.asyncio
async def test_malformed_control_message_keeps_the_view() -> None:
    plan = _plan()
    websocket = AsyncMock()
    websocket.receive = AsyncMock(side_effect=[
        {"type": "websocket.receive", "text": '{"__ctrl": true, "resize": {"cols": "x", "rows": 24}}'},
        {"type": "websocket.receive", "text": '{"__ctrl": true, "paste": 5}'},
        {"type": "websocket.disconnect"},
    ])
    control = _control_terminal()
    with ExitStack() as stack:
        for name, value in {
            "_setup_connection": AsyncMock(return_value=(plan, _view(plan, control))),
            "_run_batch_loop": AsyncMock(),
            "_heartbeat_loop": AsyncMock(),
        }.items():
            stack.enter_context(patch(f"{MODULE}.{name}", new=value))
        await handle_a_term_connection(websocket, plan.session_id)
    assert websocket.receive.await_count == 3
    control.resize.assert_not_called()
    websocket.close.assert_not_awaited()
    control.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_client_is_closed_when_the_message_loop_raises() -> None:
    plan = _plan()
    control = _control_terminal()
    websocket = AsyncMock()
    with ExitStack() as stack:
        for name, value in {
            "_setup_connection": AsyncMock(return_value=(plan, _view(plan, control))),
            "_run_batch_loop": AsyncMock(),
            "_heartbeat_loop": AsyncMock(),
            "_run_message_loop": AsyncMock(side_effect=RuntimeError("loop died")),
        }.items():
            stack.enter_context(patch(f"{MODULE}.{name}", new=value))
        await handle_a_term_connection(websocket, plan.session_id)
    control.close.assert_awaited_once()
    assert websocket.close.await_args.kwargs["code"] == 1011
