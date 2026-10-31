"""st aico wait / waits: the Tether wait routes they call (fixture receipts only)."""

import pytest
from aico_cli_fixtures import admin

WAIT = {"id": "5f1c0a9b2e7d", "waiter": "0a1b2c3d", "kind": "session", "ref": "bbbb0001", "host": None,
        "until": "finished", "since": 1, "deadline": 1_793_000_000_000, "key": None, "note": "store lane",
        "armedAt": 1, "state": "armed", "outcome": None, "line": None, "firedAt": None,
        "observed": {"state": "working", "detail": None, "title": "TEST lane"}, "kept": False}
LINE = '[Ready] session "TEST lane" (req test-lane) finished · st aico root status test-lane'


def run(monkeypatch, argv, replies, env=None):
    calls, output = [], []

    def receipt(_, endpoint, route, payload=None, **kwargs):
        calls.append((route, payload, kwargs.get("method")))
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setenv("AICO_WIDGET_ID", "0a1b2c3d")
    monkeypatch.setenv("TETHER_SOCKET", "/fixture/tether.sock")
    monkeypatch.delenv("CODEX_THREAD_ID", raising=False)
    for key, value in (env or {}).items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, value: output.append(value))
    monkeypatch.setattr(admin, "emit_unless_stopped", lambda _, value: output.append(value))
    monkeypatch.setattr(admin.time, "sleep", lambda _: None)
    return admin.main(argv), calls, output


@pytest.mark.parametrize("value, minutes", [("30m", 30), ("2h", 120), ("1h30m", 90), ("3d", 4320)])
def test_wait_minutes(value, minutes):
    assert admin.wait_minutes(value) == minutes


@pytest.mark.parametrize("value", ["", "0m", "2", "soon", "+2h"])
def test_wait_minutes_refuses_other_text(value):
    with pytest.raises(admin.argparse.ArgumentTypeError):
        admin.wait_minutes(value)


def test_session_wait_is_set_on_the_callers_session(monkeypatch):
    code, calls, output = run(monkeypatch, ["wait", "session", "test-lane", "--timeout", "2h", "--note",
                                            "store lane", "--key", "lane-1"], [(201, {**WAIT, "created": True})],
                              env={"CODEX_THREAD_ID": "019a2b3c-0000-7000-8000-000000000001"})
    assert code == 0
    route, payload, method = calls[0]
    assert route == "/v1/waits" and method is None
    assert payload == {"kind": "session", "ref": "test-lane", "until": "finished", "waiter": "0a1b2c3d",
                       "thread": "019a2b3c-0000-7000-8000-000000000001", "timeoutMinutes": 120,
                       "note": "store lane", "key": "lane-1"}
    assert output[0]["applied"] is True and output[0]["created"] is True
    assert output[0]["wait"]["id"] == WAIT["id"] and output[0]["wait"]["observed"]["state"] == "working"


def test_a_wait_already_over_says_its_line_is_coming(monkeypatch):
    fired = {**WAIT, "state": "fired", "outcome": "until", "line": LINE, "firedAt": 2, "created": True}
    code, _, output = run(monkeypatch, ["wait", "session", "bbbb0001"], [(201, fired)])
    assert code == 0 and output[0]["wait"]["line"] == LINE and "already over" in output[0]["note"]


@pytest.mark.parametrize("error, words", [
    ("not_main_agent", "--block"),
    ("wait_unsupported", "--block"),
    ("self_wait", "itself"),
    ("too_many_waits", "cancel one"),
])
def test_refusals_are_explained(monkeypatch, error, words):
    code, _, output = run(monkeypatch, ["wait", "session", "bbbb0001"], [(409, {"error": error})])
    assert code == 1 and output[0]["applied"] is False and output[0]["reason"] == error
    assert words in output[0]["detail"]


def test_a_long_timeout_is_explained(monkeypatch):
    code, _, output = run(monkeypatch, ["wait", "session", "bbbb0001", "--timeout", "8d"],
                          [(400, {"error": "invalid_body", "field": "timeoutMinutes", "max": 10080})])
    assert code == 1 and output[0]["detail"] == "--timeout is at most 7d"


def test_block_holds_until_the_line_and_prints_it(monkeypatch, capsys):
    blocking = {**WAIT, "waiter": None}
    code, calls, _ = run(monkeypatch, ["wait", "session", "bbbb0001", "--block"], [
        (201, {**blocking, "created": True}),
        admin.Unavailable("owner_unavailable"),
        (200, blocking),
        (200, {**blocking, "state": "fired", "outcome": "until", "line": LINE}),
    ])
    assert code == 0 and capsys.readouterr().out.strip() == LINE
    assert calls[0][1]["waiter"] is None and calls[0][1]["by"] == "0a1b2c3d" and "thread" not in calls[0][1]
    assert [call[0] for call in calls[1:]] == [f"/v1/waits/{WAIT['id']}?wait=55"] * 3


def test_block_exits_3_on_a_timeout(monkeypatch, capsys):
    over = {**WAIT, "waiter": None, "state": "timed_out", "outcome": "timeout", "line": "[Wait timed out] x"}
    code, _, _ = run(monkeypatch, ["wait", "get", WAIT["id"], "--block"], [(200, over)])
    assert code == 3 and capsys.readouterr().out.strip() == "[Wait timed out] x"


def test_block_exits_2_when_tether_is_unreachable(monkeypatch):
    code, _, output = run(monkeypatch, ["wait", "session", "bbbb0001", "--block"],
                          [admin.Unavailable("owner_unavailable")])
    assert code == 2 and output[0]["reason"] == "owner_unavailable"


def test_block_works_outside_aico(monkeypatch, capsys):
    monkeypatch.setattr(admin, "caller_widget_id", lambda: None)
    fired = {**WAIT, "waiter": None, "state": "fired", "outcome": "until", "line": LINE, "created": True}
    code, calls, _ = run(monkeypatch, ["wait", "session", "bbbb0001", "--block", "--widget-id", ""],
                         [(201, fired)])
    assert code == 0 and calls[0][1]["by"] is None and capsys.readouterr().out.strip() == LINE


def test_session_wait_without_a_session_points_at_block(monkeypatch, capsys):
    with pytest.raises(SystemExit):
        run(monkeypatch, ["wait", "session", "bbbb0001", "--widget-id", ""], [])
    assert "--block" in capsys.readouterr().err


def test_cancel_confirms_and_explains_a_wait_already_over(monkeypatch):
    code, calls, output = run(monkeypatch, ["wait", "cancel", WAIT["id"]],
                              [(200, {**WAIT, "cancelled": True, "state": "cancelled"})])
    assert code == 0 and calls[0] == (f"/v1/waits/{WAIT['id']}", None, "DELETE")
    assert output[0]["applied"] is True and "no line" in output[0]["detail"]
    code, _, output = run(monkeypatch, ["wait", "cancel", WAIT["id"]],
                          [(409, {"error": "not_armed", "state": "fired"})])
    assert code == 1 and output[0]["state"] == "fired" and "already over" in output[0]["detail"]


def test_waits_lists_this_sessions_waits(monkeypatch):
    code, calls, output = run(monkeypatch, ["waits", "--recent"], [(200, {"items": [WAIT]})])
    assert code == 0 and calls[0][0] == "/v1/sessions/0a1b2c3d/waits?recent=1"
    assert output[0]["items"][0]["note"] == "store lane"


def test_wait_time_is_a_wake(monkeypatch):
    wake = {"id": "5f1c0a9b2e7d", "dueAt": 1_793_000_000_000, "note": "check", "createdBy": "agent"}
    code, calls, _ = run(monkeypatch, ["wait", "time", "+1h", "check"], [(201, wake)])
    assert code == 0 and calls[0][0] == "/v1/sessions/0a1b2c3d/wakes"
