"""st aico wake: time formats and the Tether wake routes it calls (fixture receipts only)."""

import datetime

import pytest
from aico_cli_fixtures import admin

NOW = datetime.datetime(2026, 10, 26, 17, 0, tzinfo=datetime.timezone(datetime.timedelta(hours=-4)))


def ms(at: datetime.datetime) -> int:
    return int(at.timestamp() * 1000)


@pytest.mark.parametrize("value, expected", [
    ("+2h", NOW + datetime.timedelta(hours=2)),
    ("+30m", NOW + datetime.timedelta(minutes=30)),
    ("+1h30m", NOW + datetime.timedelta(hours=1, minutes=30)),
    ("17:30", NOW.replace(minute=30)),
    ("9:05", NOW.replace(hour=9, minute=5) + datetime.timedelta(days=1)),
    ("17:00", NOW + datetime.timedelta(days=1)),
    ("2026-10-27T08:00:00-04:00", NOW.replace(hour=8) + datetime.timedelta(days=1)),
])
def test_wake_time_formats(value, expected):
    assert admin.wake_time(value, NOW) == ms(expected)


@pytest.mark.parametrize("value", ["+", "+2", "25:00", "soon", "+2d"])
def test_wake_time_refuses_other_text(value):
    with pytest.raises(admin.argparse.ArgumentTypeError):
        admin.wake_time(value, NOW)


def run(monkeypatch, argv, replies):
    calls, output = [], []

    def receipt(_, endpoint, route, payload=None, **kwargs):
        calls.append((route, payload, kwargs.get("method")))
        return replies.pop(0)

    monkeypatch.setenv("AICO_WIDGET_ID", "0a1b2c3d")
    monkeypatch.setenv("TETHER_SOCKET", "/fixture/tether.sock")
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, value: output.append(value))
    monkeypatch.setattr(admin, "emit_unless_stopped", lambda _, value: output.append(value))
    return admin.main(["wake", *argv]), calls, output


WAKE = {"id": "5f1c0a9b2e7d", "dueAt": 1_793_000_000_000, "note": "check lanes", "createdBy": "agent"}


def test_set_posts_to_the_callers_session(monkeypatch):
    code, calls, output = run(monkeypatch, ["+1h", "check lanes"], [(201, WAKE)])
    assert code == 0
    route, payload, method = calls[0]
    assert route == "/v1/sessions/0a1b2c3d/wakes" and method is None
    assert payload["note"] == "check lanes" and isinstance(payload["dueAt"], int)
    assert output[0]["applied"] is True and output[0]["wake"]["id"] == WAKE["id"]


def test_set_explains_a_refusal(monkeypatch):
    code, _, output = run(monkeypatch, ["set", "+1h", "x"], [(409, {"error": "wake_unsupported"})])
    assert code == 1
    assert output[0]["applied"] is False and output[0]["reason"] == "wake_unsupported"
    assert "Claude Code or Codex" in output[0]["detail"]


def test_list_and_cancel_only_this_sessions_wakes(monkeypatch):
    code, _, output = run(monkeypatch, ["list"], [(200, {"items": [WAKE], "policy": {}})])
    assert code == 0 and output[0]["items"][0]["note"] == "check lanes"
    code, calls, output = run(monkeypatch, ["cancel", WAKE["id"]],
                              [(200, {"items": [WAKE]}), (200, {"deleted": True})])
    assert code == 0 and calls[1] == (f"/v1/wakes/{WAKE['id']}", None, "DELETE")
    code, calls, output = run(monkeypatch, ["cancel", "000000000000"], [(200, {"items": [WAKE]})])
    assert code == 1 and output[0]["reason"] == "not_found" and len(calls) == 1


def test_needs_a_session(monkeypatch):
    monkeypatch.setattr(admin, "caller_widget_id", lambda: None)
    with pytest.raises(SystemExit):
        admin.wake_main(["list", "--widget-id", "nope"])
