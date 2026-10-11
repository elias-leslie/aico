"""WebSocket control messages: PTY resize, the window-size claim and dispatch."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock, patch

import pytest

from a_term.api.handlers.websocket_messages import ViewContext, handle_websocket_message
from a_term.tether import TetherError, get_client

from .fake_tether import FakeTether

LEGACY_NAME = "summitflow-123e4567-e89b-12d3-a456-426614174000"


def _resize(cols: int = 90, rows: int = 28, *, claim: bool | None = None) -> dict[str, str]:
    payload: dict[str, object] = {"__ctrl": True, "resize": {"cols": cols, "rows": rows}}
    if claim is not None:
        payload["claim"] = claim
    return {"text": json.dumps(payload)}


def _send(message: dict, view: ViewContext):
    return asyncio.run(handle_websocket_message(message, view))


def _tether_view(fake: FakeTether, **overrides) -> tuple[ViewContext, dict]:
    session = fake.add_session(origin="a-term")
    view = ViewContext(
        session_id=session["id"],
        master_fd=7,
        tmux_session_name=session["tmux"]["sessionName"],
        tmux_socket=session["tmux"]["socket"],
        kind="tether",
        generation=session["generation"],
        client_pid=4242,
        **overrides,
    )
    return view, session


@pytest.fixture()
def pty_resize():
    with patch("a_term.api.handlers.websocket_messages.resize_pty") as mock:
        yield mock


@pytest.fixture()
def tmux_resize():
    with patch("a_term.api.handlers.websocket_messages.resize_tmux_window", return_value=True) as mock:
        yield mock


@pytest.fixture()
def no_sleep():
    with patch("a_term.api.handlers.websocket_messages.time.sleep") as mock:
        yield mock


# ---------------------------------------------------------------------------
# Resize and claim
# ---------------------------------------------------------------------------


def test_resize_without_claim_only_resizes_this_views_pty(fake_tether: FakeTether, pty_resize, tmux_resize) -> None:
    view, _ = _tether_view(fake_tether)
    assert _send(_resize(), view) == (90, 28)
    pty_resize.assert_called_once_with(7, 90, 28)
    assert fake_tether.state.resize_claims == []
    tmux_resize.assert_not_called()


def test_claim_false_does_not_claim(fake_tether: FakeTether, pty_resize) -> None:
    view, _ = _tether_view(fake_tether)
    _send(_resize(claim=False), view)
    assert fake_tether.state.resize_claims == []


def test_repeated_dimensions_skip_the_pty_but_still_claim(fake_tether: FakeTether, pty_resize) -> None:
    view, _ = _tether_view(fake_tether)
    _send(_resize(claim=True), view)
    _send(_resize(claim=True), view)
    pty_resize.assert_called_once_with(7, 90, 28)
    assert len(fake_tether.state.resize_claims) == 2


def test_dimensions_are_clamped(fake_tether: FakeTether, pty_resize) -> None:
    view, _ = _tether_view(fake_tether)
    assert _send(_resize(99999, 0), view) == (512, 1)


def test_tether_claim_names_the_views_tmux_client_and_generation(fake_tether: FakeTether, pty_resize) -> None:
    view, session = _tether_view(fake_tether)
    _send(_resize(120, 40, claim=True), view)
    assert fake_tether.state.resize_claims == [
        {"id": session["id"], "generation": session["generation"], "clientPid": 4242, "cols": 120, "rows": 40}
    ]


def test_refused_claim_is_retried_a_bounded_number_of_times(
    fake_tether: FakeTether, pty_resize, no_sleep
) -> None:
    view, _ = _tether_view(fake_tether)
    fake_tether.state.resize_results = [{"applied": False, "reason": "client_not_attached"}] * 10
    _send(_resize(claim=True), view)
    assert len(fake_tether.state.resize_claims) == 5
    assert no_sleep.call_count == 4


def test_claim_retry_stops_once_applied(fake_tether: FakeTether, pty_resize, no_sleep) -> None:
    view, _ = _tether_view(fake_tether)
    fake_tether.state.resize_results = [{"applied": False, "reason": "client_not_attached"}, {"applied": True}]
    _send(_resize(claim=True), view)
    assert len(fake_tether.state.resize_claims) == 2


def test_stale_generation_is_re_read_once(fake_tether: FakeTether, pty_resize) -> None:
    view, session = _tether_view(fake_tether)
    # The workload was respawned elsewhere: the view's generation is stale.
    current = get_client().respawn_session(session["id"], session["generation"])
    _send(_resize(claim=True), view)

    assert view.generation == current["generation"]
    assert [claim["generation"] for claim in fake_tether.state.resize_claims] == [current["generation"]]


def test_persistently_stale_generation_gives_up(fake_tether: FakeTether, pty_resize) -> None:
    view, _ = _tether_view(fake_tether)
    with patch(
        "a_term.tether.client.TetherClient.resize_claim", side_effect=TetherError(409, "stale_generation")
    ) as claim:
        _send(_resize(claim=True), view)
    assert claim.call_count == 2


def test_claim_with_tether_down_is_harmless(tether_down: str, pty_resize) -> None:
    view = ViewContext(
        session_id="deadbeef", master_fd=7, tmux_session_name="tether-deadbeef",
        tmux_socket="/tmp/x.sock", kind="tether", generation="a" * 64, client_pid=1,
    )
    assert _send(_resize(claim=True), view) == (90, 28)


def test_tether_claim_needs_a_client_pid_and_generation(fake_tether: FakeTether, pty_resize) -> None:
    view, _ = _tether_view(fake_tether)
    view.client_pid = None
    _send(_resize(claim=True), view)
    assert fake_tether.state.resize_claims == []


def test_legacy_claim_resizes_the_default_server_window(pty_resize, tmux_resize) -> None:
    view = ViewContext(session_id="legacy", master_fd=7, tmux_session_name=LEGACY_NAME, kind="legacy")
    _send(_resize(100, 30, claim=True), view)
    tmux_resize.assert_called_once_with(LEGACY_NAME, 100, 30)


def test_legacy_claim_refuses_unmanaged_names(pty_resize, tmux_resize) -> None:
    view = ViewContext(session_id="x", master_fd=7, tmux_session_name="someone-else", kind="legacy")
    _send(_resize(claim=True), view)
    tmux_resize.assert_not_called()


def test_external_claim_only_resizes_the_pty(pty_resize, tmux_resize) -> None:
    view = ViewContext(session_id="claude-work", master_fd=7, tmux_session_name="claude-work", kind="external")
    with patch("a_term.tether.client.TetherClient.resize_claim") as claim:
        assert _send(_resize(claim=True), view) == (90, 28)
    pty_resize.assert_called_once()
    tmux_resize.assert_not_called()
    claim.assert_not_called()


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


def _external_view(**overrides) -> ViewContext:
    return ViewContext(session_id="s", master_fd=7, tmux_session_name="t", kind="external", **overrides)


def test_resize_message_carries_capabilities(pty_resize) -> None:
    view = _external_view()
    message = {"text": json.dumps({"__ctrl": True, "resize": {"cols": 80, "rows": 24}, "capabilities": ["binary_protocol"]})}
    _send(message, view)
    assert view.capabilities == ["binary_protocol"]


def test_capabilities_only_message_does_not_resize(pty_resize) -> None:
    view = _external_view()
    assert _send({"text": '{"__ctrl": true, "capabilities": ["diff_sync"]}'}, view) is None
    assert view.capabilities == ["diff_sync"]
    pty_resize.assert_not_called()


def test_plain_text_and_uncontrolled_json_go_to_the_pty() -> None:
    view = _external_view()
    with patch("a_term.api.handlers.websocket_messages.os.write") as write:
        _send({"text": "ls\r"}, view)
        _send({"text": '{"resize": {"cols": 1}}'}, view)
        _send({"text": "{not json"}, view)
    assert [c.args[1] for c in write.call_args_list] == [b"ls\r", b'{"resize": {"cols": 1}}', b"{not json"]


def test_refresh_sends_ctrl_l() -> None:
    view = _external_view()
    with patch("a_term.api.handlers.websocket_messages.os.write") as write:
        _send({"text": '{"__ctrl": true, "refresh": true}'}, view)
    write.assert_called_once_with(7, b"\x0c")


def test_ping_and_renderer_status_never_write() -> None:
    view = _external_view()
    with patch("a_term.api.handlers.websocket_messages.os.write") as write:
        _send({"text": '{"__ctrl": true, "ping": true}'}, view)
        _send({"text": json.dumps({"__ctrl": True, "renderer_status": {"renderer": "webgl"}})}, view)
    write.assert_not_called()


def test_commit_feeds_backpressure() -> None:
    backpressure = MagicMock()
    view = _external_view(backpressure=backpressure)
    _send({"text": '{"__ctrl": true, "commit": 4096}'}, view)
    backpressure.record_commit.assert_called_once_with(4096)


class _Socket:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(text)


def test_scroll_request_reads_the_sessions_own_socket() -> None:
    socket = _Socket()
    view = ViewContext(session_id="s", master_fd=7, tmux_session_name="tether-1", tmux_socket="/tmp/t.sock",
                       kind="tether", websocket=socket)
    with patch("a_term.services.scrollback_pager.get_scrollback_range", return_value=(["a", "b"], 10)) as rng:
        _send({"text": json.dumps({"__ctrl": True, "scroll_request": {"from_line": 3, "count": 2}})}, view)
    rng.assert_called_once_with("tether-1", 3, 2, "/tmp/t.sock")
    assert json.loads(socket.sent[0])["scrollback_page"] == {"from_line": 3, "lines": ["a", "b"], "total_lines": 10}


def test_latest_scroll_request_counts_back_from_the_end() -> None:
    socket = _Socket()
    view = ViewContext(session_id="s", master_fd=7, tmux_session_name="tether-1", tmux_socket="/tmp/t.sock",
                       kind="tether", websocket=socket)
    with (
        patch("a_term.services.scrollback_pager.get_scrollback_line_count", return_value=500) as count,
        patch("a_term.services.scrollback_pager.get_scrollback_range", return_value=(["x"], 500)) as rng,
    ):
        _send({"text": json.dumps({"__ctrl": True, "scroll_request": {"count": 100}})}, view)
    count.assert_called_once_with("tether-1", "/tmp/t.sock")
    rng.assert_called_once_with("tether-1", 400, 100, "/tmp/t.sock")


def test_pane_mode_request_uses_the_sessions_socket() -> None:
    socket = _Socket()
    view = ViewContext(session_id="s", master_fd=7, tmux_session_name="tether-1", tmux_socket="/tmp/t.sock",
                       kind="tether", websocket=socket)
    with patch("a_term.services.scrollback_pager.get_pane_mode", return_value=(True, False)) as mode:
        _send({"text": '{"__ctrl": true, "pane_mode_request": true}'}, view)
    mode.assert_called_once_with("tether-1", "/tmp/t.sock")
    assert json.loads(socket.sent[0])["pane_mode"] == {"alternate_screen": True, "mouse_reporting": False}


def test_binary_input_frame_goes_to_the_pty() -> None:
    view = _external_view()
    with patch("a_term.api.handlers.websocket_messages.os.write") as write:
        _send({"bytes": b"\x01hello"}, view)
    write.assert_called_once_with(7, b"hello")


def test_binary_control_frame_is_a_control_message(fake_tether: FakeTether, pty_resize) -> None:
    view, _ = _tether_view(fake_tether)
    frame = b"\x02" + json.dumps({"__ctrl": True, "resize": {"cols": 70, "rows": 20}, "claim": True}).encode()
    assert _send({"bytes": frame}, view) == (70, 20)
    assert len(fake_tether.state.resize_claims) == 1


def test_single_byte_binary_is_raw_input() -> None:
    view = _external_view()
    with patch("a_term.api.handlers.websocket_messages.os.write") as write:
        _send({"bytes": b"\x03"}, view)
    write.assert_called_once_with(7, b"\x03")


def test_empty_message_is_ignored() -> None:
    assert _send({"type": "websocket.receive"}, _external_view()) is None
