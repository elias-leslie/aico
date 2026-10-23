"""A-Term's Tether client against the fake Tether."""

from __future__ import annotations

import pytest

from a_term.tether import TetherError, TetherUnavailable, TetherVersionError, get_client
from a_term.tether.client import default_socket_path

from .fake_tether import FakeTether


def test_socket_path_prefers_tether_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TETHER_SOCKET", "/tmp/x/control.sock")
    assert str(default_socket_path()) == "/tmp/x/control.sock"


def test_socket_path_defaults_to_runtime_dir(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TETHER_SOCKET", raising=False)
    monkeypatch.delenv("TETHER_INSTANCE", raising=False)
    monkeypatch.setenv("XDG_RUNTIME_DIR", "/run/user/1234")
    assert str(default_socket_path()) == "/run/user/1234/tether/default/control.sock"


def test_version_gate(fake_tether: FakeTether) -> None:
    assert get_client().require_api_version(1)["apiVersion"] == 1
    fake_tether.state.api_version = 0
    with pytest.raises(TetherVersionError):
        get_client().require_api_version(1)


def test_create_sends_origin_size_and_a_term_id(fake_tether: FakeTether) -> None:
    descriptor = get_client().create_session(
        origin="a-term", cols=100, rows=40, tool="claude", project_id="p", project_root="/tmp", a_term_session_id="u-1"
    )
    assert descriptor["tool"] == "claude-code"
    assert descriptor["origin"] == "a-term"
    method, path, body = fake_tether.calls[-1]
    assert (method, path) == ("POST", "/v1/sessions")
    assert body["size"] == {"cols": 100, "rows": 40}
    assert body["aTermSessionId"] == "u-1"


def test_errors_carry_status_and_code(fake_tether: FakeTether) -> None:
    session = fake_tether.add_session()
    with pytest.raises(TetherError) as caught:
        get_client().end_session(session["id"], "0" * 64)
    assert (caught.value.status, caught.value.code) == (409, "stale_generation")


def test_unreachable_socket_is_unavailable(tether_down: str) -> None:
    with pytest.raises(TetherUnavailable):
        get_client().health()


def test_events_stream_yields_ndjson(fake_tether: FakeTether) -> None:
    session = fake_tether.add_session()
    fake_tether.end(session["id"])
    events = list(get_client().events())
    assert events[0]["type"] == "hello"
    assert [event["type"] for event in events[1:]] == ["session.created", "session.ended"]
