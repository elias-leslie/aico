"""WebSocket view setup: attach plan -> PTY -> initial size -> initial scrollback."""

from __future__ import annotations

import json
from contextlib import ExitStack
from unittest.mock import ANY, AsyncMock, MagicMock, patch

import pytest

from a_term.api.handlers.session_validation import AttachPlan
from a_term.api.handlers.websocket_connection import (
    _poll_for_resize,
    _run_session,
    _setup_connection,
    handle_a_term_connection,
)
from a_term.api.handlers.websocket_messages import ViewContext
from a_term.constants import SHELL_MODE
from a_term.services.tmux_control import SEED_HISTORY_LINES

MODULE = "a_term.api.handlers.websocket_connection"
SOCKET = "/tmp/tether-test/tmux-a0000001.sock"


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
    )


@pytest.mark.asyncio
async def test_initial_capabilities_complete_without_a_resize() -> None:
    websocket = AsyncMock()
    websocket.receive = AsyncMock(return_value={
        "type": "websocket.receive",
        "text": '{"__ctrl": true, "capabilities": ["binary_protocol", "demand_paging"]}',
    })
    view = ViewContext(session_id="s", master_fd=7, tmux_session_name="t")
    with patch("a_term.api.handlers.websocket_messages.resize_pty") as mock_pty:
        assert await _poll_for_resize(websocket, view) is True
    assert view.capabilities == ["binary_protocol", "demand_paging"]
    mock_pty.assert_not_called()


@pytest.mark.asyncio
async def test_disconnect_before_resize_ends_the_wait() -> None:
    websocket = AsyncMock()
    websocket.receive = AsyncMock(return_value={"type": "websocket.disconnect"})
    view = ViewContext(session_id="s", master_fd=7, tmux_session_name="t")
    assert await _poll_for_resize(websocket, view) is False


@pytest.mark.asyncio
async def test_setup_spawns_tethers_argv_and_builds_the_claim_identity() -> None:
    plan = _plan()
    websocket = AsyncMock()
    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.spawn_pty", return_value=(17, 23)) as spawn,
        patch(f"{MODULE}._wait_for_initial_resize", new=AsyncMock()) as wait,
        patch(f"{MODULE}.apply_external_attach_options") as apply_options,
        patch(f"{MODULE}.get_scrollback", return_value=None),
    ):
        result_plan, view, pid = await _setup_connection(websocket, "a0000001")

    spawn.assert_called_once_with(plan.argv, plan.env, plan.unset)
    apply_options.assert_not_called()
    wait.assert_awaited_once()
    assert result_plan is plan
    assert pid == 23
    assert (view.master_fd, view.client_pid, view.kind) == (17, 23, "tether")
    assert view.generation == plan.generation
    assert view.tmux_socket == SOCKET


@pytest.mark.asyncio
async def test_external_session_toggles_attach_options_on_its_server() -> None:
    plan = _plan(kind="external", name="codex-agent-hub")
    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.apply_external_attach_options", return_value=True) as apply_options,
        patch(f"{MODULE}.spawn_pty", return_value=(17, 23)),
        patch(f"{MODULE}._wait_for_initial_resize", new=AsyncMock()),
        patch(f"{MODULE}.get_scrollback", return_value=None),
    ):
        await _setup_connection(AsyncMock(), "codex-agent-hub")
    apply_options.assert_called_once_with("codex-agent-hub")


@pytest.mark.asyncio
async def test_failed_setup_cleans_up_the_pty_and_restores_options() -> None:
    plan = _plan(kind="external", name="codex-agent-hub")
    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.apply_external_attach_options", return_value=True),
        patch(f"{MODULE}.restore_external_attach_options", return_value=True) as restore,
        patch(f"{MODULE}.spawn_pty", return_value=(17, 23)),
        patch(f"{MODULE}._wait_for_initial_resize", new=AsyncMock(side_effect=RuntimeError("boom"))),
        patch(f"{MODULE}._cleanup_pty_process", new=AsyncMock()) as cleanup,
        pytest.raises(RuntimeError, match="boom"),
    ):
        await _setup_connection(AsyncMock(), "codex-agent-hub")
    cleanup.assert_awaited_once_with(23, 17)
    restore.assert_called_once_with("codex-agent-hub")


@pytest.mark.asyncio
async def test_spawn_failure_restores_options_without_a_pty() -> None:
    plan = _plan(kind="external", name="codex-agent-hub")
    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.apply_external_attach_options", return_value=True),
        patch(f"{MODULE}.restore_external_attach_options", return_value=True) as restore,
        patch(f"{MODULE}.spawn_pty", side_effect=OSError("no pty")),
        patch(f"{MODULE}._cleanup_pty_process", new=AsyncMock()) as cleanup,
        pytest.raises(OSError),
    ):
        await _setup_connection(AsyncMock(), "codex-agent-hub")
    cleanup.assert_not_awaited()
    restore.assert_called_once_with("codex-agent-hub")


@pytest.mark.asyncio
async def test_shell_scrollback_snapshot_reads_the_sessions_socket() -> None:
    plan = _plan(mode=SHELL_MODE)
    websocket = AsyncMock()
    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.spawn_pty", return_value=(17, 23)),
        patch(f"{MODULE}._wait_for_initial_resize", new=AsyncMock()),
        patch(f"{MODULE}.get_scrollback_with_cursor", return_value=("line 1\nline 2\n", (4, 9))) as capture,
    ):
        await _setup_connection(websocket, "a0000001")

    capture.assert_called_once_with("tether-a0000001", 5000, SOCKET)
    payload = json.loads(websocket.send_text.await_args.args[0])
    assert payload == {
        "__ctrl": True,
        "scrollback_sync": "line 1\r\nline 2\r\n",
        "scrollback_cursor_x": 4,
        "scrollback_cursor_y": 9,
    }


@pytest.mark.asyncio
async def test_agent_sessions_get_a_prefetched_scrollback_page() -> None:
    plan = _plan(mode="claude-code")
    websocket = AsyncMock()
    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.spawn_pty", return_value=(17, 23)),
        patch(f"{MODULE}._wait_for_initial_resize", new=AsyncMock()),
        patch(f"{MODULE}.get_scrollback", return_value="line 1\nline 2\n") as capture,
        patch(f"{MODULE}.get_scrollback_line_count", return_value=0) as history,
    ):
        await _setup_connection(websocket, "a0000001")

    capture.assert_called_once_with("tether-a0000001", 5000, SOCKET)
    history.assert_called_once_with("tether-a0000001", SOCKET)
    payload = json.loads(websocket.send_text.await_args.args[0])
    assert payload["scrollback_page"] == {"from_line": 0, "lines": ["line 1", "line 2"], "total_lines": 0}


@pytest.mark.asyncio
async def test_demand_paging_shell_gets_viewport_init_from_its_socket() -> None:
    plan = _plan(mode=SHELL_MODE)
    websocket = AsyncMock()

    async def fake_wait(_websocket, view, timeout=5.0):
        view.capabilities.extend(["demand_paging"])
        return True

    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.spawn_pty", return_value=(17, 23)),
        patch(f"{MODULE}._wait_for_initial_resize", new=fake_wait),
        patch(f"{MODULE}.get_viewport_lines", return_value=("a\nb", 2, 0)) as viewport,
        patch(f"{MODULE}.get_cursor_position", return_value=(1, 1)),
    ):
        await _setup_connection(websocket, "a0000001")

    viewport.assert_called_once_with("tether-a0000001", 50, SOCKET)
    assert json.loads(websocket.send_text.await_args.args[0])["viewport_init"]["total_lines"] == 2


@pytest.mark.asyncio
async def test_dead_session_closes_with_session_dead() -> None:
    websocket = AsyncMock()
    with patch(f"{MODULE}.validate_and_prepare_session", side_effect=ValueError("Session not found: x")):
        assert await _run_session(websocket, "x") is None
    websocket.close.assert_awaited_once()
    reason = json.loads(websocket.close.await_args.kwargs["reason"])
    assert reason == {"error": "session_dead", "message": "Session not found: x"}
    assert websocket.close.await_args.kwargs["code"] == 4000


def _view(plan: AttachPlan) -> ViewContext:
    return ViewContext(
        session_id=plan.session_id, master_fd=17, tmux_session_name=plan.tmux_session_name,
        tmux_socket=plan.tmux_socket, kind=plan.kind, generation=plan.generation, client_pid=23,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["tether", "external"])
async def test_run_session_syncs_scrollback_and_restores_only_external_options(kind: str) -> None:
    plan = _plan(kind=kind, name="tether-a0000001" if kind == "tether" else "codex-agent-hub")
    websocket = AsyncMock()
    scheduler = MagicMock()
    scheduler.close = AsyncMock()
    tracker = MagicMock()
    with (
        patch(f"{MODULE}._setup_connection", new=AsyncMock(return_value=(plan, _view(plan), 23))),
        patch(f"{MODULE}._run_message_loop", new=AsyncMock()),
        patch(f"{MODULE}.read_pty_output", new=AsyncMock()),
        patch(f"{MODULE}._heartbeat_loop", new=AsyncMock()),
        patch(f"{MODULE}.ScrollbackSyncScheduler", return_value=scheduler) as scheduler_cls,
        patch(f"{MODULE}.ScrollbackSyncOutputTracker", return_value=tracker),
        patch(f"{MODULE}.restore_external_attach_options", return_value=True) as restore,
        patch(f"{MODULE}._cleanup_pty_process", new=AsyncMock()) as cleanup,
    ):
        await _run_session(websocket, plan.session_id)

    cleanup.assert_awaited_once_with(23, 17)

    if kind == "tether":
        scheduler_cls.assert_called_once_with(
            websocket, "tether-a0000001", use_binary=False, diff_tracker=None, diag=ANY,
            get_scrollback_with_cursor_fn=ANY,
        )
    else:
        scheduler_cls.assert_called_once_with(
            websocket, plan.tmux_session_name, use_binary=False, diff_tracker=None, diag=ANY,
        )
    scheduler.close.assert_awaited_once()
    if kind == "external":
        restore.assert_called_once_with("codex-agent-hub")
    else:
        restore.assert_not_called()


@pytest.mark.asyncio
async def test_tether_scrollback_sync_captures_from_the_sessions_socket() -> None:
    plan = _plan()
    captured: dict = {}

    def fake_scheduler(websocket, name, **kwargs):
        captured.update(kwargs)
        scheduler = MagicMock()
        scheduler.close = AsyncMock()
        return scheduler

    with (
        patch(f"{MODULE}._setup_connection", new=AsyncMock(return_value=(plan, _view(plan), 23))),
        patch(f"{MODULE}._run_message_loop", new=AsyncMock()),
        patch(f"{MODULE}.read_pty_output", new=AsyncMock()),
        patch(f"{MODULE}._heartbeat_loop", new=AsyncMock()),
        patch(f"{MODULE}.ScrollbackSyncScheduler", side_effect=fake_scheduler),
        patch(f"{MODULE}.ScrollbackSyncOutputTracker", return_value=MagicMock()),
        patch(f"{MODULE}.get_scrollback_with_cursor", return_value=("x", None)) as capture,
        patch(f"{MODULE}._cleanup_pty_process", new=AsyncMock()),
    ):
        await _run_session(AsyncMock(), plan.session_id)
        captured["get_scrollback_with_cursor_fn"]("tether-a0000001")

    capture.assert_called_once_with("tether-a0000001", socket_name=SOCKET)


def _patch_pty_run(stack: ExitStack, plan: AttachPlan, **overrides) -> None:
    """Run a PTY view for real around a mocked setup, reader and scrollback sync."""
    scheduler = MagicMock()
    scheduler.close = AsyncMock()
    targets = {
        "_setup_connection": AsyncMock(return_value=(plan, _view(plan), 23)),
        "read_pty_output": AsyncMock(),
        "_heartbeat_loop": AsyncMock(),
        "ScrollbackSyncScheduler": MagicMock(return_value=scheduler),
        "ScrollbackSyncOutputTracker": MagicMock(),
        **overrides,
    }
    for name, value in targets.items():
        stack.enter_context(patch(f"{MODULE}.{name}", new=value))


@pytest.mark.asyncio
async def test_malformed_control_message_keeps_the_view_and_still_cleans_up_the_pty() -> None:
    plan = _plan()
    websocket = AsyncMock()
    websocket.receive = AsyncMock(side_effect=[
        {"type": "websocket.receive", "text": '{"__ctrl": true, "resize": {"cols": "x", "rows": 24}}'},
        {"type": "websocket.receive", "text": '{"__ctrl": true, "commit": "many"}'},
        {"type": "websocket.disconnect"},
    ])
    cleanup = AsyncMock()
    with ExitStack() as stack:
        _patch_pty_run(stack, plan, _cleanup_pty_process=cleanup)
        pty_resize = stack.enter_context(patch("a_term.api.handlers.websocket_messages.resize_pty"))
        await handle_a_term_connection(websocket, plan.session_id)
    assert websocket.receive.await_count == 3
    pty_resize.assert_not_called()
    websocket.close.assert_not_awaited()
    cleanup.assert_awaited_once_with(23, 17)


@pytest.mark.asyncio
async def test_pty_is_cleaned_up_when_the_message_loop_raises() -> None:
    plan = _plan()
    cleanup = AsyncMock()
    websocket = AsyncMock()
    with ExitStack() as stack:
        _patch_pty_run(
            stack, plan,
            _cleanup_pty_process=cleanup,
            _run_message_loop=AsyncMock(side_effect=RuntimeError("loop died")),
        )
        await handle_a_term_connection(websocket, plan.session_id)
    cleanup.assert_awaited_once_with(23, 17)
    assert websocket.close.await_args.kwargs["code"] == 1011


# ---------------------------------------------------------------------------
# Control-mode transport
# ---------------------------------------------------------------------------


def _control_socket(transport: str | None = "control") -> AsyncMock:
    websocket = AsyncMock()
    websocket.query_params = {"transport": transport} if transport else {}
    return websocket


def _control_terminal(pid: int = 31) -> MagicMock:
    control = MagicMock()
    control.pid = pid
    control.close = AsyncMock()
    return control


@pytest.mark.asyncio
async def test_control_view_starts_after_the_first_size_and_then_claims() -> None:
    plan = _plan()
    websocket = _control_socket()
    control = _control_terminal()

    async def fake_wait(_websocket, view, timeout=5.0):
        view.last_resize[:] = [100, 40]
        view.pending_claim = True
        return True

    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.spawn_pty") as spawn,
        patch(f"{MODULE}._wait_for_initial_resize", new=fake_wait),
        patch(f"{MODULE}.ControlTerminal.start", new=AsyncMock(return_value=control)) as start,
        patch(f"{MODULE}._claim_window_size", return_value=True) as claim,
        patch(f"{MODULE}.get_scrollback") as get_scrollback,
    ):
        _plan_out, view, pid = await _setup_connection(websocket, "a0000001")

    spawn.assert_not_called()
    get_scrollback.assert_not_called()  # the seed carries history
    assert start.await_args is not None
    args, kwargs = start.await_args
    assert args[0] == plan.argv and args[2:] == (100, 40)
    assert args[1]["COLORTERM"] == "truecolor" and "TMUX" not in args[1]
    assert kwargs["sized"] is True
    assert (view.control, view.client_pid, view.master_fd, pid) == (control, 31, -1, 31)
    claim.assert_called_once_with(view, 100, 40)
    assert view.pending_claim is False
    sent = [json.loads(call.args[0]) for call in websocket.send_text.await_args_list]
    # The browser sizes its history from this, so the seed always fits.
    assert {"__ctrl": True, "transport": "control", "history_lines": SEED_HISTORY_LINES} in sent


@pytest.mark.asyncio
async def test_control_view_without_a_size_starts_unsized() -> None:
    plan = _plan()
    control = _control_terminal()
    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}._wait_for_initial_resize", new=AsyncMock(return_value=True)),
        patch(f"{MODULE}.ControlTerminal.start", new=AsyncMock(return_value=control)) as start,
        patch(f"{MODULE}._claim_window_size") as claim,
    ):
        await _setup_connection(_control_socket(), "a0000001")
    assert start.await_args is not None and start.await_args.kwargs["sized"] is False
    claim.assert_not_called()


@pytest.mark.asyncio
async def test_server_setting_keeps_classic_attach_and_says_so() -> None:
    plan = _plan()
    websocket = _control_socket()
    with (
        patch(f"{MODULE}.TERMINAL_TRANSPORT", "attach"),
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.spawn_pty", return_value=(17, 23)) as spawn,
        patch(f"{MODULE}._wait_for_initial_resize", new=AsyncMock()),
        patch(f"{MODULE}.ControlTerminal.start", new=AsyncMock()) as start,
        patch(f"{MODULE}.get_scrollback", return_value=None),
    ):
        _plan_out, view, _pid = await _setup_connection(websocket, "a0000001")
    start.assert_not_awaited()
    spawn.assert_called_once()
    assert view.control is None and view.master_fd == 17
    sent = [json.loads(call.args[0]) for call in websocket.send_text.await_args_list]
    assert {"__ctrl": True, "transport": "attach"} in sent


@pytest.mark.asyncio
async def test_control_session_streams_its_queue_and_closes_the_client() -> None:
    plan = _plan()
    control = _control_terminal()
    view = _view(plan)
    view.master_fd = -1
    view.control = control
    with (
        patch(f"{MODULE}._setup_connection", new=AsyncMock(return_value=(plan, view, 31))),
        patch(f"{MODULE}._run_message_loop", new=AsyncMock()),
        patch(f"{MODULE}._run_batch_loop", new=AsyncMock()) as batch,
        patch(f"{MODULE}.read_pty_output", new=AsyncMock()) as read_pty,
        patch(f"{MODULE}._heartbeat_loop", new=AsyncMock()),
        patch(f"{MODULE}.ScrollbackSyncScheduler") as scheduler_cls,
        patch(f"{MODULE}._cleanup_pty_process", new=AsyncMock()) as cleanup,
    ):
        await _run_session(AsyncMock(), plan.session_id)
    cleanup.assert_not_awaited()
    assert batch.call_args.args[1] is control.queue
    assert batch.call_args.kwargs["detect_exit"] is False
    read_pty.assert_not_called()
    scheduler_cls.assert_not_called()
    control.close.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(("detect_exit", "sent"), [(True, "[exited]\n"), (False, "[exited]\nmore")])
async def test_exited_text_stops_only_attach_output(detect_exit: bool, sent: str) -> None:
    import asyncio

    from a_term.services._pty_reader import _run_batch_loop

    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    websocket = AsyncMock()
    await queue.put(b"[exited]\n")
    loop_task = asyncio.create_task(
        _run_batch_loop(websocket, queue, asyncio.get_running_loop(), detect_exit=detect_exit)
    )
    await asyncio.sleep(0.05)
    await queue.put(b"more")
    await queue.put(None)
    await asyncio.wait_for(loop_task, 1)
    assert "".join(call.args[0] for call in websocket.send_text.call_args_list) == sent


@pytest.mark.asyncio
async def test_pty_fd_is_closed_even_when_cleanup_is_cancelled() -> None:
    import asyncio

    from a_term.api.handlers.websocket_connection import _cleanup_pty_process

    async def never_exits(*_args, **_kwargs) -> bool:
        await asyncio.sleep(3600)
        return False

    with (
        patch(f"{MODULE}.os.kill"),
        patch(f"{MODULE}.os.close") as close,
        patch(f"{MODULE}._wait_for_process", new=never_exits),
    ):
        task = asyncio.create_task(_cleanup_pty_process(4242, 17))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    close.assert_called_once_with(17)
