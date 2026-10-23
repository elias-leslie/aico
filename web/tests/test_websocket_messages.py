"""WebSocket control messages: resize, the window-size claim and dispatch."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock, patch

import pytest

from a_term.api.handlers.websocket_messages import ViewContext, handle_websocket_message
from a_term.tether import TetherError, get_client

from .fake_tether import FakeTether


def _resize(cols: int = 90, rows: int = 28, *, claim: bool | None = None) -> dict[str, str]:
    payload: dict[str, object] = {"__ctrl": True, "resize": {"cols": cols, "rows": rows}}
    if claim is not None:
        payload["claim"] = claim
    return {"text": json.dumps(payload)}


def _send(message: dict, view: ViewContext):
    return asyncio.run(handle_websocket_message(message, view))


def _control(view: ViewContext) -> MagicMock:
    assert isinstance(view.control, MagicMock)
    return view.control


def _tether_view(fake: FakeTether, **overrides) -> tuple[ViewContext, dict]:
    session = fake.add_session(origin="a-term")
    view = ViewContext(
        session_id=session["id"],
        tmux_session_name=session["tmux"]["sessionName"],
        tmux_socket=session["tmux"]["socket"],
        kind="tether",
        generation=session["generation"],
        client_pid=4242,
        control=MagicMock(),
        **overrides,
    )
    return view, session


@pytest.fixture()
def tmux_resize():
    """Any tmux command A-Term would run itself (a shared-window resize would be one)."""
    with patch("a_term.utils.tmux.run_tmux_command", return_value=(True, "")) as mock:
        yield mock


@pytest.fixture()
def no_sleep():
    with patch("a_term.api.handlers.websocket_messages.time.sleep") as mock:
        yield mock


# ---------------------------------------------------------------------------
# Resize and claim
# ---------------------------------------------------------------------------


def test_resize_without_claim_only_resizes_this_views_pty(fake_tether: FakeTether, tmux_resize) -> None:
    view, _ = _tether_view(fake_tether)
    assert _send(_resize(), view) == (90, 28)
    _control(view).resize.assert_called_once_with(90, 28)
    assert fake_tether.state.resize_claims == []
    tmux_resize.assert_not_called()


def test_claim_false_does_not_claim(fake_tether: FakeTether) -> None:
    view, _ = _tether_view(fake_tether)
    _send(_resize(claim=False), view)
    assert fake_tether.state.resize_claims == []


def test_repeated_dimensions_skip_the_resize_but_still_claim(fake_tether: FakeTether) -> None:
    view, _ = _tether_view(fake_tether)
    _send(_resize(claim=True), view)
    _send(_resize(claim=True), view)
    _control(view).resize.assert_called_once_with(90, 28)
    assert len(fake_tether.state.resize_claims) == 2


def test_dimensions_are_clamped(fake_tether: FakeTether) -> None:
    view, _ = _tether_view(fake_tether)
    assert _send(_resize(99999, 0), view) == (512, 1)


def test_tether_claim_names_the_views_tmux_client_and_generation(fake_tether: FakeTether) -> None:
    view, session = _tether_view(fake_tether)
    _send(_resize(120, 40, claim=True), view)
    assert fake_tether.state.resize_claims == [
        {"id": session["id"], "generation": session["generation"], "clientPid": 4242, "cols": 120, "rows": 40}
    ]


def test_refused_claim_is_retried_a_bounded_number_of_times(
    fake_tether: FakeTether, no_sleep
) -> None:
    view, _ = _tether_view(fake_tether)
    fake_tether.state.resize_results = [{"applied": False, "reason": "client_not_attached"}] * 10
    _send(_resize(claim=True), view)
    assert len(fake_tether.state.resize_claims) == 5
    assert no_sleep.call_count == 4


@pytest.mark.parametrize("reason", ["window_linked", "status_row", "invalid", "something_new"])
def test_permanent_refusal_is_not_retried(fake_tether: FakeTether, no_sleep, reason: str) -> None:
    view, _ = _tether_view(fake_tether)
    fake_tether.state.resize_results = [{"applied": False, "reason": reason}] * 5
    _send(_resize(claim=True), view)
    assert len(fake_tether.state.resize_claims) == 1
    assert no_sleep.call_count == 0


def test_tmux_unavailable_is_retried(fake_tether: FakeTether, no_sleep) -> None:
    view, _ = _tether_view(fake_tether)
    fake_tether.state.resize_results = [{"applied": False, "reason": "tmux_unavailable"}, {"applied": True}]
    _send(_resize(claim=True), view)
    assert len(fake_tether.state.resize_claims) == 2


def test_stale_reason_re_reads_the_generation_once(fake_tether: FakeTether, no_sleep) -> None:
    view, session = _tether_view(fake_tether)
    fake_tether.state.resize_results = [{"applied": False, "reason": "stale"}] * 3
    _send(_resize(claim=True), view)
    reads = [call for call in fake_tether.calls if call[:2] == ("GET", f"/v1/sessions/{session['id']}")]
    assert len(reads) == 1
    assert len(fake_tether.state.resize_claims) == 2
    assert no_sleep.call_count == 0


def test_claim_retry_stops_once_applied(fake_tether: FakeTether, no_sleep) -> None:
    view, _ = _tether_view(fake_tether)
    fake_tether.state.resize_results = [{"applied": False, "reason": "client_not_attached"}, {"applied": True}]
    _send(_resize(claim=True), view)
    assert len(fake_tether.state.resize_claims) == 2


def test_stale_generation_is_re_read_once(fake_tether: FakeTether) -> None:
    view, session = _tether_view(fake_tether)
    # The workload was respawned elsewhere: the view's generation is stale.
    current = get_client().respawn_session(session["id"], session["generation"])
    _send(_resize(claim=True), view)

    assert view.generation == current["generation"]
    assert [claim["generation"] for claim in fake_tether.state.resize_claims] == [current["generation"]]


def test_persistently_stale_generation_gives_up(fake_tether: FakeTether) -> None:
    view, _ = _tether_view(fake_tether)
    with patch(
        "a_term.tether.client.TetherClient.resize_claim", side_effect=TetherError(409, "stale_generation")
    ) as claim:
        _send(_resize(claim=True), view)
    assert claim.call_count == 2


def test_claim_with_tether_down_is_harmless(tether_down: str) -> None:
    view = ViewContext(
        session_id="deadbeef", tmux_session_name="tether-deadbeef",
        tmux_socket="/tmp/x.sock", kind="tether", generation="a" * 64, client_pid=1, control=MagicMock(),
    )
    assert _send(_resize(claim=True), view) == (90, 28)


def test_tether_claim_needs_a_client_pid_and_generation(fake_tether: FakeTether) -> None:
    view, _ = _tether_view(fake_tether)
    view.client_pid = None
    _send(_resize(claim=True), view)
    assert fake_tether.state.resize_claims == []


def test_external_claim_only_resizes_the_client(tmux_resize) -> None:
    view = ViewContext(session_id="claude-work", tmux_session_name="claude-work", kind="external", control=MagicMock())
    with patch("a_term.tether.client.TetherClient.resize_claim") as claim:
        assert _send(_resize(claim=True), view) == (90, 28)
    _control(view).resize.assert_called_once()
    tmux_resize.assert_not_called()
    claim.assert_not_called()


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


def _external_view(**overrides) -> ViewContext:
    return ViewContext(session_id="s", tmux_session_name="t", kind="external", control=MagicMock(), **overrides)


def test_resize_message_carries_capabilities() -> None:
    view = _external_view()
    message = {"text": json.dumps({"__ctrl": True, "resize": {"cols": 80, "rows": 24}, "capabilities": ["binary_protocol"]})}
    _send(message, view)
    assert view.capabilities == ["binary_protocol"]


def test_capabilities_only_message_does_not_resize() -> None:
    view = _external_view()
    assert _send({"text": '{"__ctrl": true, "capabilities": ["binary_protocol"]}'}, view) is None
    assert view.capabilities == ["binary_protocol"]
    _control(view).resize.assert_not_called()


def test_plain_text_and_uncontrolled_json_go_to_the_session() -> None:
    view = _external_view()
    _send({"text": "ls\r"}, view)
    _send({"text": '{"resize": {"cols": 1}}'}, view)
    _send({"text": "{not json"}, view)
    assert [c.args[0] for c in _control(view).write.call_args_list] == [
        b"ls\r", b'{"resize": {"cols": 1}}', b"{not json",
    ]


def test_ping_and_renderer_status_never_write() -> None:
    view = _external_view()
    _send({"text": '{"__ctrl": true, "ping": true}'}, view)
    _send({"text": json.dumps({"__ctrl": True, "renderer_status": {"renderer": "webgl"}})}, view)
    _control(view).write.assert_not_called()


def test_binary_input_frame_goes_to_the_session() -> None:
    view = _external_view()
    _send({"bytes": b"\x01hello"}, view)
    _control(view).write.assert_called_once_with(b"hello")


def test_binary_control_frame_is_a_control_message(fake_tether: FakeTether) -> None:
    view, _ = _tether_view(fake_tether)
    frame = b"\x02" + json.dumps({"__ctrl": True, "resize": {"cols": 70, "rows": 20}, "claim": True}).encode()
    assert _send({"bytes": frame}, view) == (70, 20)
    assert len(fake_tether.state.resize_claims) == 1


def test_single_byte_binary_is_raw_input() -> None:
    view = _external_view()
    _send({"bytes": b"\x03"}, view)
    _control(view).write.assert_called_once_with(b"\x03")


def test_empty_message_is_ignored() -> None:
    assert _send({"type": "websocket.receive"}, _external_view()) is None


def test_input_before_the_control_client_exists_is_dropped() -> None:
    view = ViewContext(session_id="s", tmux_session_name="t", kind="external")
    assert _send({"text": "ls\r"}, view) is None


# ---------------------------------------------------------------------------
# Input, size, refresh and paste go to the tmux control client
# ---------------------------------------------------------------------------


def test_view_routes_input_resize_refresh_and_paste() -> None:
    control = MagicMock()
    control.paste = MagicMock(side_effect=lambda text: asyncio.sleep(0))
    view = ViewContext(session_id="s", tmux_session_name="t", kind="external", control=control)
    _send({"text": "ls\r"}, view)
    _send({"bytes": b"\x01" + b"q"}, view)
    _send(_resize(100, 40), view)
    _send({"text": json.dumps({"__ctrl": True, "refresh": True})}, view)
    _send({"text": json.dumps({"__ctrl": True, "paste": "a\nb"})}, view)
    assert [c.args[0] for c in control.write.call_args_list] == [b"ls\r", b"q"]
    control.resize.assert_called_once_with(100, 40)
    control.reseed.assert_called_once_with()
    control.paste.assert_called_once_with("a\nb")


def test_claim_before_the_control_client_exists_is_deferred() -> None:
    view = ViewContext(session_id="s", tmux_session_name="t", kind="external")
    with patch("a_term.api.handlers.websocket_messages._claim_window_size") as claim:
        assert _send(_resize(90, 28, claim=True), view) == (90, 28)
    claim.assert_not_called()
    assert view.pending_claim is True and view.last_resize == [90, 28]


# ---------------------------------------------------------------------------
# Malformed control messages are ignored, never raised into the view's loop
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "ctrl",
    [
        {"resize": {"cols": "x", "rows": 24}},
        {"resize": {"cols": 80, "rows": None}},
        {"resize": {"cols": [80], "rows": 24}},
        {"resize": "80x24"},
        {"paste": 5},
        {"paste": ["a"]},
    ],
)
def test_malformed_control_message_is_ignored(ctrl: dict) -> None:
    view = _external_view()
    message = {"text": json.dumps({"__ctrl": True, **ctrl})}
    assert _send(message, view) is None
    _control(view).resize.assert_not_called()
    _control(view).write.assert_not_called()
    _control(view).paste.assert_not_called()
    assert view.last_resize == [0, 0]


def test_non_finite_dimension_is_ignored() -> None:
    view = _external_view()
    assert _send({"text": '{"__ctrl": true, "resize": {"cols": Infinity, "rows": NaN}}'}, view) is None
    _control(view).resize.assert_not_called()


def test_numeric_strings_still_resize() -> None:
    view = _external_view()
    assert _send({"text": json.dumps({"__ctrl": True, "resize": {"cols": "100", "rows": "30"}})}, view) == (100, 30)


def test_integer_past_the_digit_limit_is_input_not_a_crash() -> None:
    view = _external_view()
    text = '{"__ctrl": true, "ping": ' + "1" * 5000 + "}"
    assert _send({"text": text}, view) is None
    _control(view).resize.assert_not_called()
    assert _control(view).write.call_args.args[0] == text.encode("utf-8")
