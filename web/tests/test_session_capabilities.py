"""The capability table: what A-Term may do to each kind of session.

Three layers, all through the module's interface:
- the pure table, ``refusal(action, facts)`` for every fact row and action;
- builder-made sessions, whose ``can_*`` flags must equal ``refusal(...) is None``;
- one HTTP route per refusal, pinning today's status and detail.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from a_term.services import session_catalog
from a_term.services.session_capabilities import (
    ACTIONS,
    LifecycleError,
    Refusal,
    SessionFacts,
    flags,
    refusal,
)

from . import session_factory as make
from .fake_tether import FakeTether

LEGACY_ATTACH_ONLY = ("legacy_attach_only", "This session predates Tether and is attach-only", 409)
NOT_TETHER = ("not_tether", "Only Tether sessions can be renamed", 400)
ROOT_RESPAWN = ("root_single_launch", "A root session runs one launch; start a new root instead", 409)
OWN_TMUX_RESPAWN = ("own_tmux_read_only", "External tmux sessions are read-only", 400)
OWN_TMUX_START = ("own_tmux_read_only", "External tmux agent session is already running", None)
ROOT_START = ("root_single_launch", "Root launch is owned by its retained request", None)
SHELL_START = ("shell_mode", "Session is in shell mode, not agent mode", 400)
OWN_TMUX_END = ("own_tmux_read_only", "Only Tether and legacy A-Term sessions can be ended here", 400)

TETHER = SessionFacts("tether", mode="codex")
TETHER_ROOT = SessionFacts("tether", is_root=True, mode="codex")
TETHER_ROOT_SHELL = SessionFacts("tether", is_root=True, mode="shell")
TETHER_STATUS_LEGACY = SessionFacts("tether", is_legacy=True, mode="codex")
# Cannot exist (roots postdate Tether) but pins both orders: respawn checks legacy first, start_agent root first.
TETHER_ROOT_STATUS_LEGACY = SessionFacts("tether", is_root=True, is_legacy=True, mode="codex")
TETHER_SHELL = SessionFacts("tether", mode="shell")
LEGACY_AGENT = SessionFacts("legacy", is_legacy=True, mode="codex")
LEGACY_SHELL = SessionFacts("legacy", is_legacy=True, mode="shell")
OWN_TMUX = SessionFacts("tmux_external", mode="claude")

# fact row -> (rename, respawn, start_agent, end); None = allowed.
TABLE: dict[str, tuple[SessionFacts, tuple[tuple[str, str, int | None] | None, ...]]] = {
    "tether": (TETHER, (None, None, None, None)),
    "tether root": (TETHER_ROOT, (None, ROOT_RESPAWN, ROOT_START, None)),
    "tether root shell": (TETHER_ROOT_SHELL, (None, ROOT_RESPAWN, ROOT_START, None)),
    "tether status legacy": (TETHER_STATUS_LEGACY, (None, LEGACY_ATTACH_ONLY, LEGACY_ATTACH_ONLY, None)),
    "tether root status legacy": (TETHER_ROOT_STATUS_LEGACY, (None, LEGACY_ATTACH_ONLY, ROOT_START, None)),
    "tether shell": (TETHER_SHELL, (None, None, SHELL_START, None)),
    "legacy agent": (LEGACY_AGENT, (NOT_TETHER, LEGACY_ATTACH_ONLY, LEGACY_ATTACH_ONLY, None)),
    "legacy shell": (LEGACY_SHELL, (NOT_TETHER, LEGACY_ATTACH_ONLY, SHELL_START, None)),
    "own tmux": (OWN_TMUX, (NOT_TETHER, OWN_TMUX_RESPAWN, OWN_TMUX_START, OWN_TMUX_END)),
}


# ---------------------------------------------------------------------------
# The pure table
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("row", list(TABLE))
@pytest.mark.parametrize("action", ACTIONS)
def test_refusal_table(row: str, action: str) -> None:
    facts, expected = TABLE[row]
    want = expected[ACTIONS.index(action)]
    got = refusal(action, facts)
    assert got == (Refusal(*want) if want else None)


@pytest.mark.parametrize("row", list(TABLE))
def test_flags_are_refusal_is_none(row: str) -> None:
    facts, expected = TABLE[row]
    rename, respawn, _start, end = expected
    assert flags(facts) == {"can_rename": rename is None, "can_respawn": respawn is None, "can_end": end is None}


def test_refusal_error_carries_status_and_detail() -> None:
    error = refusal("respawn", TETHER_ROOT).error()  # type: ignore[union-attr]
    assert isinstance(error, LifecycleError)
    assert (error.status_code, error.detail) == (409, ROOT_RESPAWN[1])


def test_a_declined_refusal_is_never_raised() -> None:
    declined = refusal("start_agent", OWN_TMUX)
    assert declined is not None and declined.status is None
    with pytest.raises(ValueError, match="declined"):
        declined.error()


def test_facts_of_a_partial_session_is_an_error() -> None:
    with pytest.raises(KeyError):
        SessionFacts.of({"source": "tether", "mode": "codex"})
    with pytest.raises(ValueError, match="Unknown session kind"):
        SessionFacts.of({"source": "other", "is_root": False, "is_legacy": False, "mode": "codex"})


def test_lifecycle_error_is_the_same_class_everywhere() -> None:
    from a_term.services import lifecycle

    assert lifecycle.LifecycleError is LifecycleError


# ---------------------------------------------------------------------------
# Builder-made sessions
# ---------------------------------------------------------------------------
LINK = {"pane_id": "pane-x", "display_order": 1, "last_accessed_at": None, "created_at": None, "mode": "codex"}


def _built_sessions() -> list[tuple[str, session_catalog.Session, SessionFacts]]:
    return [
        ("tether linked", make.tether(link=LINK), TETHER),
        ("tether unlinked", make.tether(), TETHER),
        ("tether root", make.tether(rootRequestId="req-1"), TETHER_ROOT),
        ("tether status legacy", make.tether(link=LINK, status="legacy"), TETHER_STATUS_LEGACY),
        ("tether shell", make.tether(tool="shell"), TETHER_SHELL),
        ("legacy unlinked", make.legacy(), LEGACY_AGENT),
        ("legacy linked shell", make.legacy(link={**LINK, "mode": "shell"}), LEGACY_SHELL),
        ("own tmux", make.own_tmux(), OWN_TMUX),
    ]


def test_built_sessions_carry_their_capability_flags() -> None:
    for label, session, facts in _built_sessions():
        assert SessionFacts.of(session) == facts, label
        expected = tuple(refusal(action, facts) is None for action in ("rename", "respawn", "end"))
        assert (session["can_rename"], session["can_respawn"], session["can_end"]) == expected, label


def test_own_tmux_sessions_are_listed_with_flags(no_default_tmux: MagicMock, tether_down: str) -> None:
    no_default_tmux.return_value = (True, make.own_tmux_panes())
    (session,) = session_catalog.list_sessions()
    assert session["source"] == "tmux_external"
    assert (session["can_rename"], session["can_respawn"], session["can_end"]) == (False, False, False)


# ---------------------------------------------------------------------------
# One HTTP route per refusal
# ---------------------------------------------------------------------------
LEGACY_LINE = f"summitflow-{make.LEGACY_ID}\t$1\t%1\t/tmp\tcodex\t999999999"


def _default_server(run: MagicMock, line: str) -> None:
    def fake_run(args: list[str], **_: Any) -> tuple[bool, str]:
        return (True, line) if args[0] == "list-panes" else (False, "unsupported")

    run.side_effect = fake_run


def _detail(response: Any) -> tuple[int, str]:
    return response.status_code, response.json()["detail"]


def test_rename_refuses_own_tmux_and_legacy(test_app: TestClient, no_default_tmux: MagicMock) -> None:
    _default_server(no_default_tmux, make.own_tmux_panes())
    assert _detail(test_app.patch("/api/a-term/sessions/claude-work", json={"name": "x"})) == (400, NOT_TETHER[1])
    _default_server(no_default_tmux, LEGACY_LINE)
    assert _detail(test_app.patch(f"/api/a-term/sessions/{make.LEGACY_ID}", json={"name": "x"})) == (400, NOT_TETHER[1])


def test_reset_refuses_root_legacy_and_own_tmux(
    test_app: TestClient, fake_tether: FakeTether, no_default_tmux: MagicMock
) -> None:
    root = fake_tether.add_session(root_request_id="req-1")
    assert _detail(test_app.post(f"/api/a-term/sessions/{root['id']}/reset")) == (409, ROOT_RESPAWN[1])
    _default_server(no_default_tmux, LEGACY_LINE)
    assert _detail(test_app.post(f"/api/a-term/sessions/{make.LEGACY_ID}/reset")) == (409, LEGACY_ATTACH_ONLY[1])
    _default_server(no_default_tmux, make.own_tmux_panes())
    assert _detail(test_app.post("/api/a-term/sessions/claude-work/reset")) == (400, OWN_TMUX_RESPAWN[1])
    assert not any(path.endswith("/respawn") for _, path, _ in fake_tether.calls)


def test_start_agent_declines_root_and_own_tmux(
    test_app: TestClient, fake_tether: FakeTether, no_default_tmux: MagicMock
) -> None:
    root = fake_tether.add_session(root_request_id="req-1", status="uncertain")
    body = test_app.post(f"/api/a-term/sessions/{root['id']}/start-agent").json()
    assert (body["started"], body["message"], body["agent_state"]) == (False, ROOT_START[1], "error")
    _default_server(no_default_tmux, make.own_tmux_panes())
    response = test_app.post("/api/a-term/sessions/claude-work/start-agent")
    assert response.status_code == 200
    assert (response.json()["started"], response.json()["message"]) == (False, OWN_TMUX_START[1])
    assert not any(path.endswith("/respawn") for _, path, _ in fake_tether.calls)


def test_start_agent_refuses_shell_and_legacy(
    test_app: TestClient, fake_tether: FakeTether, no_default_tmux: MagicMock
) -> None:
    shell = fake_tether.add_session(tool="shell")
    assert _detail(test_app.post(f"/api/a-term/sessions/{shell['id']}/start-agent")) == (400, SHELL_START[1])
    _default_server(no_default_tmux, LEGACY_LINE)
    assert _detail(test_app.post(f"/api/a-term/sessions/{make.LEGACY_ID}/start-agent")) == (409, LEGACY_ATTACH_ONLY[1])


def test_delete_own_tmux_only_closes_the_view(test_app: TestClient, fake_tether: FakeTether) -> None:
    response = test_app.delete("/api/a-term/sessions/claude-work")
    assert response.status_code == 200
    assert response.json()["is_external"] is True
    assert not any(path.endswith("/end") for _, path, _ in fake_tether.calls)


def test_session_list_carries_flags_per_source(
    test_app: TestClient, fake_tether: FakeTether, no_default_tmux: MagicMock
) -> None:
    _default_server(no_default_tmux, f"{LEGACY_LINE}\n{make.own_tmux_panes()}")
    plain = fake_tether.add_session()
    root = fake_tether.add_session(root_request_id="req-1")
    items = {item["id"]: item for item in test_app.get("/api/a-term/sessions").json()["items"]}

    def caps(session_id: str) -> tuple[bool, bool, bool]:
        item = items[session_id]
        return item["can_rename"], item["can_respawn"], item["can_end"]

    assert caps(plain["id"]) == (True, True, True)
    assert caps(root["id"]) == (True, False, True)
    assert caps(make.LEGACY_ID) == (False, False, True)
    assert caps("claude-work") == (False, False, False)
