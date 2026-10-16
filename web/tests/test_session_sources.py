"""The session catalog's adapters, one per kind, and the catalog dispatch over them.

Adapters are exercised with an injected pane reader (``ListContext``) and an
injected ``tool_tokens``; the catalog is exercised through its own interface
(``kind_of``, ``list_sessions``, ``get_session``, ``attach_plan``, ``end``,
``live_ids``) against the fake Tether and a faked default tmux server.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from a_term.services import agent_tools, lifecycle, session_catalog
from a_term.services._session_sources import ListContext
from a_term.services._session_sources import own_tmux as own_tmux_module
from a_term.services._session_sources.legacy import LegacySource
from a_term.services._session_sources.own_tmux import OwnTmuxSource
from a_term.services._session_sources.tether import TetherSource
from a_term.services._session_sources.tmux_panes import PaneRow, read_panes
from a_term.services.session_capabilities import LifecycleError
from a_term.storage import panes as pane_store
from a_term.tether import TetherUnavailable

from . import session_factory as make
from .fake_tether import TMUX_BIN, FakeTether

LEGACY_ID = "123e4567-e89b-12d3-a456-426614174000"
LEGACY_LINE = f"summitflow-{LEGACY_ID}\t$1\t%1\t/home/u/proj\tbash\t42"


def _row(name: str, command: str, cwd: str = "", session_id: str = "$9", pane_id: str = "%9", pid: str = "0") -> PaneRow:
    return PaneRow(name, session_id, pane_id, cwd, command, pid)


def _ctx(*rows: PaneRow, links: dict[str, Any] | None = None) -> ListContext:
    return ListContext.build(links or {}, lambda: list(rows))


def _no_project(_working_dir: str | None) -> str | None:
    return None


def _default_server(lines: str):
    """A fake default tmux server whose ``list-panes -a`` prints ``lines``; records every call."""
    calls: list[list[str]] = []

    def fake_run(args: list[str], check: bool = False, socket_name: str | None = None) -> tuple[bool, str]:
        assert socket_name is None
        calls.append(list(args))
        return (True, lines) if args[:2] == ["list-panes", "-a"] else (False, "unexpected")

    return fake_run, calls


# ---------------------------------------------------------------------------
# kind_of: the only place id shape is read
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("ref", "kind"),
    [
        ("a1b2c3d4", "tether"),
        ("deadbeef", "tether"),
        (LEGACY_ID, "legacy"),
        ("claude-work", "tmux_external"),
        ("A1B2C3D4", "tmux_external"),  # Tether ids are lower-case hex
        ("a1b2c3d", "tmux_external"),
        ("summitflow-" + LEGACY_ID, "tmux_external"),
        ("", "tmux_external"),
    ],
)
def test_kind_of_reads_only_the_id_shape(ref: str, kind: str) -> None:
    with patch("a_term.utils.tmux.run_tmux_command", side_effect=AssertionError("no lookup")):
        assert session_catalog.kind_of(ref) == kind


# ---------------------------------------------------------------------------
# One pane reader
# ---------------------------------------------------------------------------
def test_read_panes_parses_six_fields_and_skips_anything_else() -> None:
    output = "\n".join([
        "claude-work\t$3\t%3\t/srv/w\tclaude\t42",
        "old-five-field\t%4\t/srv/x\tcodex\t0",  # the old 5-field shape is gone
        "",
    ])
    with patch("a_term.utils.tmux.run_tmux_command", return_value=(True, output)) as run:
        assert read_panes() == [PaneRow("claude-work", "$3", "%3", "/srv/w", "claude", "42")]
    (args,) = run.call_args.args
    assert args[:3] == ["list-panes", "-a", "-F"]


def test_read_panes_is_empty_without_a_server() -> None:
    with patch("a_term.utils.tmux.run_tmux_command", return_value=(False, "no server running")):
        assert read_panes() == []


def test_list_sessions_reads_the_default_server_once(fake_tether: FakeTether) -> None:
    fake_tether.add_session()
    fake_run, calls = _default_server(f"{LEGACY_LINE}\n{make.own_tmux_panes()}")
    with patch("a_term.utils.tmux.run_tmux_command", side_effect=fake_run):
        sessions = session_catalog.list_sessions()
    assert sorted(session["source"] for session in sessions) == ["legacy", "tether", "tmux_external"]
    assert [args[0] for args in calls] == ["list-panes"]


def test_session_lookups_read_the_default_server_once(fake_tether: FakeTether) -> None:
    fake_run, calls = _default_server(make.own_tmux_panes())
    with patch("a_term.utils.tmux.run_tmux_command", side_effect=fake_run):
        assert session_catalog.sessions_by_id() == {}
        assert session_catalog.get_session("claude-work") is not None
    assert [args[0] for args in calls] == ["list-panes", "list-panes"]


# ---------------------------------------------------------------------------
# Own tmux adapter (discovery moved from test_tmux_utils)
# ---------------------------------------------------------------------------
def test_own_tmux_discovers_agent_sessions_and_skips_legacy_and_shells() -> None:
    projects = {
        "/home/testuser/summitflow": "summitflow",
        "/home/testuser/agent-hub": "agent-hub",
        "/home/testuser/research": "research",
        "/home/testuser/a-term": "a-term",
        "/home/testuser/antigravity": "antigravity",
    }
    source = OwnTmuxSource(project_of=projects.get)
    ctx = _ctx(
        _row("claude-summitflow", "claude", "/home/testuser/summitflow"),
        _row(f"summitflow-{LEGACY_ID}", "bash", "/home/testuser/summitflow"),
        _row("codex-agent-hub", "codex", "/home/testuser/agent-hub"),
        _row("pi-research", "pi", "/home/testuser/research"),
        _row("pi-a-term", "pi", "/home/testuser/a-term"),
        _row("agy-antigravity", "agy", "/home/testuser/antigravity"),
        _row("scratch", "vim", "/tmp"),
    )
    sessions = source.list(ctx)

    assert [session["id"] for session in sessions] == [
        "agy-antigravity",
        "claude-summitflow",
        "codex-agent-hub",
        "pi-a-term",
        "pi-research",
    ]
    by_id = {session["id"]: session for session in sessions}
    assert (by_id["claude-summitflow"]["project_id"], by_id["claude-summitflow"]["mode"]) == ("summitflow", "claude-code")
    assert (by_id["codex-agent-hub"]["project_id"], by_id["codex-agent-hub"]["mode"]) == ("agent-hub", "codex")
    assert (by_id["pi-research"]["project_id"], by_id["pi-research"]["mode"]) == ("research", "pi")
    assert (by_id["pi-a-term"]["project_id"], by_id["pi-a-term"]["mode"]) == ("a-term", "pi")
    assert (by_id["agy-antigravity"]["project_id"], by_id["agy-antigravity"]["mode"]) == ("antigravity", "agy")
    for session in sessions:
        assert session["tmux_socket"] is None and session["tmux_source"] == "default"
        assert (session["can_rename"], session["can_respawn"], session["can_end"]) == (False, False, False)


def test_own_tmux_project_inference_uses_the_git_toplevel() -> None:
    source = OwnTmuxSource()
    with patch("a_term.services._session_sources.own_tmux.subprocess.run", return_value=MagicMock(stdout="/home/testuser/default\n")) as run:
        (session,) = source.list(_ctx(_row("codex-default", "codex", "/home/testuser/default/sub")))
    assert session["project_id"] == "default"
    assert run.call_args.args[0] == ["git", "-C", "/home/testuser/default/sub", "rev-parse", "--show-toplevel"]


def test_own_tmux_keeps_the_first_pane_with_a_working_dir() -> None:
    source = OwnTmuxSource(project_of=_no_project)
    (session,) = source.list(
        _ctx(
            _row("claude-x", "claude", "", pane_id="%1"),
            _row("claude-x", "claude", "/srv/a", pane_id="%2"),
            _row("claude-x", "claude", "/srv/b", pane_id="%3"),
        )
    )
    assert (session["working_dir"], session["tmux_pane_id"]) == ("/srv/a", "%2")


def test_own_tmux_tool_tokens_are_injectable() -> None:
    ctx = _ctx(_row("gemini-work", "gemini"), _row("claude-work", "claude"))
    assert [s["id"] for s in OwnTmuxSource(project_of=_no_project).list(ctx)] == ["claude-work"]
    custom = OwnTmuxSource(tool_tokens=lambda: {"gemini": "gemini-cli"}, project_of=_no_project)
    assert [(s["id"], s["mode"]) for s in custom.list(ctx)] == [("gemini-work", "gemini-cli")]


def test_own_tmux_tokens_come_from_tethers_tools(fake_tether: FakeTether) -> None:
    """Slug, aliases, process name and argv program all name the tool; the mode is its slug."""
    fake_tether.state.tools["gemini-cli"] = {
        **fake_tether.state.tools["codex"], "slug": "gemini-cli", "name": "Gemini", "argv": ["/opt/bin/gem", "-y"],
        "processName": "gemini", "aliases": ["gem-old"],
    }
    tokens = agent_tools.agent_tokens()
    assert tokens["claude"] == tokens["claude-code"] == "claude-code"
    assert tokens["gemini"] == tokens["gem"] == tokens["gem-old"] == tokens["gemini-cli"] == "gemini-cli"
    assert "shell" not in tokens and "aider" not in tokens
    source = OwnTmuxSource(project_of=_no_project)
    ctx = _ctx(_row("work", "gemini"), _row("claude-work", "claude"), _row("old", "aider"))
    assert [(s["id"], s["mode"]) for s in source.list(ctx)] == [("claude-work", "claude-code"), ("work", "gemini-cli")]


def test_own_tmux_tokens_survive_tether_going_down(fake_tether: FakeTether, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_tether.state.tools["gemini-cli"] = {**fake_tether.state.tools["codex"], "slug": "gemini-cli", "processName": "gemini"}
    assert agent_tools.agent_tokens()["gemini"] == "gemini-cli"
    monkeypatch.setattr(agent_tools, "list_tools", MagicMock(side_effect=TetherUnavailable("down")))
    agent_tools._AGENT_TOKENS._expires = 0.0  # the cached read is due again
    assert agent_tools.agent_tokens()["gemini"] == "gemini-cli"  # last tokens Tether gave


def test_own_tmux_tokens_before_tether_ever_answers_are_the_shipped_agents() -> None:
    """No Tether at all (the default in tests): the built-in tokens, mapped to canonical slugs."""
    assert dict(agent_tools.agent_tokens()) == dict(agent_tools.FALLBACK_AGENT_TOKENS)
    source = OwnTmuxSource(project_of=_no_project)
    assert source.infer_mode("claude-work", "claude") == ("claude-code", "running")
    assert source.infer_mode("aider-work", "aider") == ("shell", "not_started")


def test_own_tmux_tokens_are_reread_after_a_tool_edit(fake_tether: FakeTether) -> None:
    assert "gemini" not in agent_tools.agent_tokens()
    agent_tools.create_tool({"slug": "gemini-cli", "name": "Gemini", "command": "gemini", "process_name": "gemini"})
    assert agent_tools.agent_tokens()["gemini"] == "gemini-cli"


def test_own_tmux_mode_inference_requires_token_boundaries() -> None:
    source = OwnTmuxSource()
    assert source.infer_mode("pi-a-term", "node") == ("pi", "running")
    assert source.infer_mode("antigravity", "agy") == ("agy", "running")
    assert source.infer_mode("api-service", "python") == ("shell", "not_started")


def test_own_tmux_mode_inference_finds_an_agent_below_a_shell_pane() -> None:
    """An agent started from a shell shares its process group.

    tmux then reports the shell as ``pane_current_command``, so the pane has to
    be classified from its process tree or the agent looks like a shell.
    """
    with patch.object(own_tmux_module, "_pane_descendant_labels", return_value=["claude-real claude-real"]):
        assert OwnTmuxSource().infer_mode("agent-e03c60b0", "bash", "4242") == ("claude-code", "running")


def test_own_tmux_mode_inference_keeps_plain_shell_panes_as_shells() -> None:
    with patch.object(own_tmux_module, "_pane_descendant_labels", return_value=["git git", "less less"]):
        assert OwnTmuxSource().infer_mode("scratch-bfa0cfb0", "bash", "4242") == ("shell", "not_started")


def test_own_tmux_mode_inference_skips_the_process_scan_for_non_shell_panes() -> None:
    with patch.object(own_tmux_module, "_pane_descendant_labels", side_effect=AssertionError("must not scan")):
        assert OwnTmuxSource().infer_mode("scratch", "vim", "4242") == ("shell", "not_started")


def test_own_tmux_get_matches_id_or_tmux_name() -> None:
    source = OwnTmuxSource(project_of=_no_project)
    ctx = _ctx(_row("claude-summitflow", "claude"))
    assert source.get("claude-summitflow", ctx) is not None
    assert source.get("missing", ctx) is None


def test_own_tmux_end_raises_todays_400() -> None:
    with pytest.raises(LifecycleError) as caught:
        OwnTmuxSource().end("claude-work")
    assert (caught.value.status_code, caught.value.detail) == (
        400,
        "Only Tether and legacy A-Term sessions can be ended here",
    )


def test_own_tmux_live_ids_are_the_discovered_sessions() -> None:
    with patch("a_term.utils.tmux.run_tmux_command", return_value=(True, make.own_tmux_panes("codex-x", "codex"))):
        assert OwnTmuxSource().live_ids() == {"codex-x"}


# ---------------------------------------------------------------------------
# Legacy adapter
# ---------------------------------------------------------------------------
def test_legacy_lists_managed_panes_and_infers_mode_through_the_injected_reader() -> None:
    seen: list[tuple[str, str, str | None]] = []

    def infer(name: str, command: str, pid: str | None = None) -> tuple[str, str]:
        seen.append((name, command, pid))
        return "codex", "running"

    source = LegacySource(infer_mode=infer)
    ctx = _ctx(
        _row(f"summitflow-{LEGACY_ID}", "bash", "/srv/old", "$1", "%1", "42"),
        _row(f"summitflow-{LEGACY_ID}", "vim", "/srv/other", "$1", "%5", "43"),  # second pane: ignored
        _row("claude-work", "claude"),
    )
    (session,) = source.list(ctx)
    assert (session["id"], session["mode"], session["working_dir"], session["tmux_pane_id"]) == (
        LEGACY_ID,
        "codex",
        "/srv/old",
        "%1",
    )
    assert seen == [(f"summitflow-{LEGACY_ID}", "bash", "42")]
    assert (session["can_rename"], session["can_respawn"], session["can_end"]) == (False, False, True)


def test_legacy_linked_mode_comes_from_the_link() -> None:
    pane = pane_store.create_pane(pane_type="adhoc", pane_name="Old")
    link = pane_store.link_session(LEGACY_ID, pane["id"], "shell", kind="legacy")
    source = LegacySource(infer_mode=lambda *_: pytest.fail("a linked session never infers its mode"))
    session = source.get(LEGACY_ID, _ctx(_row(f"summitflow-{LEGACY_ID}", "codex"), links={LEGACY_ID: link}))
    assert session is not None
    assert (session["mode"], session["name"], session["is_external"]) == ("shell", "Old", False)


def test_legacy_get_missing_is_none() -> None:
    assert LegacySource(infer_mode=OwnTmuxSource().infer_mode).get(LEGACY_ID, _ctx()) is None


def test_legacy_end_kills_exactly_and_live_ids_list_sessions() -> None:
    source = LegacySource(infer_mode=OwnTmuxSource().infer_mode)
    with patch("a_term.utils.tmux.kill_legacy_session", return_value=False) as kill:
        assert source.end(LEGACY_ID) is False
    kill.assert_called_once_with(LEGACY_ID)
    with patch("a_term.utils.tmux.list_tmux_sessions", return_value={LEGACY_ID}):
        assert source.live_ids() == {LEGACY_ID}


# ---------------------------------------------------------------------------
# Tether adapter
# ---------------------------------------------------------------------------
def test_tether_list_and_get(fake_tether: FakeTether) -> None:
    session = fake_tether.add_session(tool="codex")
    source = TetherSource()
    (listed,) = source.list(_ctx())
    assert listed["id"] == session["id"] and listed["is_external"] is True
    assert source.get(session["id"], _ctx()) == listed
    assert source.get("deadbeef", _ctx()) is None


def test_tether_down_hides_only_tether_sessions(tether_down: str) -> None:
    assert TetherSource().list(_ctx()) == []
    with pytest.raises(TetherUnavailable):
        TetherSource().live_ids()


def test_tether_client_factory_is_injectable() -> None:
    client = MagicMock()
    client.list_sessions.return_value = [make.tether_descriptor(), {"id": None}]
    source = TetherSource(client_factory=lambda: client)
    assert source.live_ids() == {make.TETHER_ID}
    assert [session["id"] for session in source.list(_ctx())] == [make.TETHER_ID]


def test_tether_end_is_generation_fenced_and_reports_gone(fake_tether: FakeTether) -> None:
    session = fake_tether.add_session()
    source = TetherSource()
    assert source.end(session["id"]) is True
    _, path, body = fake_tether.calls[-1]
    assert path == f"/v1/sessions/{session['id']}/end"
    assert body["generation"] == session["generation"]
    assert source.end(session["id"]) is False


def test_tether_end_without_a_generation_is_409() -> None:
    client = MagicMock()
    client.get_session.return_value = {"id": make.TETHER_ID}
    with pytest.raises(LifecycleError) as caught:
        TetherSource(client_factory=lambda: client).end(make.TETHER_ID)
    assert (caught.value.status_code, caught.value.detail) == (
        409,
        "The session has no generation yet; refresh and try again",
    )
    client.end_session.assert_not_called()


# ---------------------------------------------------------------------------
# Catalog: attach_plan per kind (moved from test_session_validation)
# ---------------------------------------------------------------------------
def test_tether_attach_plan_uses_tethers_argv_and_touches_the_link(fake_tether: FakeTether) -> None:
    session = fake_tether.add_session(tool="codex")
    pane = pane_store.create_pane(pane_type="project", pane_name="P", project_id="p")
    link = pane_store.link_session(session["id"], pane["id"], "codex")
    plan = session_catalog.attach_plan(session["id"])
    assert plan.kind == "tether"
    assert plan.argv == [TMUX_BIN, "-S", session["tmux"]["socket"], "attach-session", "-t", session["tmux"]["sessionId"]]
    assert plan.session["last_accessed_at"] == link["last_accessed_at"]  # the plan reads the link before the touch
    assert pane_store.get_link(session["id"])["last_accessed_at"] >= link["last_accessed_at"]  # type: ignore[index]


def test_legacy_session_attaches_on_the_default_server(fake_tether: FakeTether) -> None:
    pane = pane_store.create_pane(pane_type="adhoc", pane_name="Old")
    pane_store.link_session(LEGACY_ID, pane["id"], "shell", kind="legacy")
    fake_run, _calls = _default_server(LEGACY_LINE)
    with (
        patch("a_term.utils.tmux.run_tmux_command", side_effect=fake_run),
        patch("a_term.services.session_catalog.pane_store.touch_link") as touch,
    ):
        plan = session_catalog.attach_plan(LEGACY_ID)

    assert plan.kind == "legacy"
    assert plan.tmux_socket is None
    assert plan.argv == ["tmux", "attach-session", "-t", f"summitflow-{LEGACY_ID}"]
    assert plan.generation is None
    touch.assert_called_once_with(LEGACY_ID)


def test_users_own_session_attaches_on_the_default_server(fake_tether: FakeTether) -> None:
    with (
        patch("a_term.utils.tmux.run_tmux_command", return_value=(True, make.own_tmux_panes("claude-work"))),
        patch("a_term.services.session_catalog.pane_store.touch_link") as touch,
    ):
        plan = session_catalog.attach_plan("claude-work")

    assert plan.kind == "external"
    assert plan.tmux_socket is None
    assert plan.argv == ["tmux", "attach-session", "-t", "claude-work"]
    touch.assert_not_called()
    # Only the tool registry (to recognise the agent); no Tether session call.
    assert [call[:2] for call in fake_tether.calls] == [("GET", "/v1/tools")]


def test_missing_legacy_session_is_reported(fake_tether: FakeTether, no_default_tmux: MagicMock) -> None:
    with pytest.raises(ValueError, match="Session not found"):
        session_catalog.attach_plan(LEGACY_ID)


def test_missing_own_tmux_session_is_reported(fake_tether: FakeTether, no_default_tmux: MagicMock) -> None:
    with pytest.raises(ValueError, match="Session not found: claude-gone"):
        session_catalog.attach_plan("claude-gone")


# ---------------------------------------------------------------------------
# Catalog: end and live_ids per kind
# ---------------------------------------------------------------------------
def test_catalog_end_dispatches_by_kind(fake_tether: FakeTether, no_default_tmux: MagicMock) -> None:
    session = fake_tether.add_session()
    assert session_catalog.end(session["id"]) is True
    assert session_catalog.end(session["id"]) is False
    with patch("a_term.utils.tmux.kill_legacy_session", return_value=True) as kill:
        assert session_catalog.end(LEGACY_ID) is True
    kill.assert_called_once_with(LEGACY_ID)
    with pytest.raises(LifecycleError) as caught:
        session_catalog.end("claude-work")
    assert caught.value.status_code == 400


def test_catalog_live_ids_per_link_kind(fake_tether: FakeTether) -> None:
    session = fake_tether.add_session()
    assert session_catalog.live_ids("tether") == {session["id"]}
    with patch("a_term.utils.tmux.list_tmux_sessions", return_value={LEGACY_ID}):
        assert session_catalog.live_ids("legacy") == {LEGACY_ID}


def test_catalog_live_ids_tether_raises_when_tether_is_down(tether_down: str) -> None:
    with pytest.raises(TetherUnavailable):
        session_catalog.live_ids("tether")


def test_reconcile_raises_during_an_outage_even_with_only_legacy_links(
    tether_down: str, no_default_tmux: MagicMock
) -> None:
    pane = pane_store.create_pane(pane_type="adhoc", pane_name="Old")
    pane_store.link_session(LEGACY_ID, pane["id"], "shell", kind="legacy")
    with pytest.raises(TetherUnavailable):
        lifecycle.reconcile_links()
    assert pane_store.get_link(LEGACY_ID) is not None
