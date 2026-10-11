"""WebSocket view setup: attach plan -> PTY -> initial size -> initial scrollback."""

from __future__ import annotations

import json
from unittest.mock import ANY, AsyncMock, MagicMock, patch

import pytest

from a_term.api.handlers.session_validation import AttachPlan
from a_term.api.handlers.websocket_connection import (
    _poll_for_resize,
    _run_session,
    _setup_connection,
)
from a_term.api.handlers.websocket_messages import ViewContext
from a_term.constants import SHELL_MODE

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

    spawn.assert_called_once_with(plan.argv, plan.env)
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
async def test_legacy_session_does_not_toggle_attach_options() -> None:
    plan = _plan(kind="legacy", name="summitflow-123e4567-e89b-12d3-a456-426614174000")
    with (
        patch(f"{MODULE}.validate_and_prepare_session", return_value=plan),
        patch(f"{MODULE}.apply_external_attach_options") as apply_options,
        patch(f"{MODULE}.spawn_pty", return_value=(17, 23)),
        patch(f"{MODULE}._wait_for_initial_resize", new=AsyncMock()),
        patch(f"{MODULE}.get_scrollback", return_value=None),
    ):
        await _setup_connection(AsyncMock(), "x")
    apply_options.assert_not_called()


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
        assert await _run_session(websocket, "x") == (None, None)
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
@pytest.mark.parametrize("kind", ["tether", "legacy", "external"])
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
    ):
        assert await _run_session(websocket, plan.session_id) == (23, 17)

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
    ):
        await _run_session(AsyncMock(), plan.session_id)
        captured["get_scrollback_with_cursor_fn"]("tether-a0000001")

    capture.assert_called_once_with("tether-a0000001", socket_name=SOCKET)
