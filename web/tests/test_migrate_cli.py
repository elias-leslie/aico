"""a-term migrate-from-postgres / import-tools, without any real Postgres."""

from __future__ import annotations

import builtins
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
import structlog

from a_term.cli import main as cli
from a_term.storage import panes as pane_store
from a_term.storage import project_settings

from .fake_tether import FakeTether

LIVE = "70b339cd-93a0-4898-8c4b-3d694ce8e8dc"
STALE = "5e9027bd-fede-42c2-b923-649fa0e5deae"
DEAD = "11111111-2222-3333-4444-555555555555"
ORPHAN = "66666666-7777-8888-9999-000000000000"
PANE = "ad54f346-e90a-4b83-9807-1a00d00cb96b"
WHEN = datetime(2026, 9, 1, tzinfo=UTC)



@pytest.fixture(autouse=True)
def _restore_logging():
    """The CLIs point structlog at the (captured) stderr; undo that per test."""
    yield
    structlog.reset_defaults()

def _source() -> dict[str, list[dict[str, Any]]]:
    return {
        "panes": [
            {"id": PANE, "pane_type": "project", "project_id": "proj", "pane_order": 2, "pane_name": "Proj",
             "active_mode": "claude", "created_at": WHEN, "width_percent": 50, "height_percent": 100,
             "grid_row": 0, "grid_col": 1, "is_detached": False},
            {"id": "8afe05a4-4525-4d20-9919-52160847f2ef", "pane_type": "adhoc", "project_id": None,
             "pane_order": 0, "pane_name": "Scratch", "active_mode": "shell", "created_at": WHEN,
             "width_percent": None, "height_percent": None, "grid_row": None, "grid_col": None, "is_detached": True},
        ],
        "project_settings": [
            {"project_id": "proj", "enabled": True, "display_order": 1, "active_mode": "claude",
             "created_at": WHEN, "updated_at": WHEN},
        ],
        "sessions": [
            {"id": LIVE, "mode": "claude", "pane_id": PANE, "is_alive": True, "display_order": 0,
             "created_at": WHEN, "last_accessed_at": WHEN, "project_id": "proj"},
            {"id": STALE, "mode": "codex", "pane_id": PANE, "is_alive": True, "created_at": WHEN},
            {"id": DEAD, "mode": "codex", "pane_id": PANE, "is_alive": False, "created_at": WHEN},
            {"id": ORPHAN, "mode": "shell", "pane_id": None, "is_alive": True, "created_at": WHEN},
        ],
        "agent_tools": [
            {"slug": "claude", "name": "Claude Code", "command": "claude --dangerously-skip-permissions",
             "process_name": "claude", "description": None, "color": None, "display_order": 0,
             "is_default": False, "enabled": True},
            {"slug": "pi", "name": "Pi", "command": "pi", "process_name": "pi-coding-agent", "description": None,
             "color": None, "display_order": 5, "is_default": False, "enabled": True},
            {"slug": "mine", "name": "Mine", "command": "mine --go", "process_name": "mine", "description": "x",
             "color": "#123456", "display_order": 7, "is_default": False, "enabled": True},
        ],
    }


def _plan() -> dict[str, Any]:
    return cli.build_plan(_source(), lambda session_id: session_id in {LIVE, ORPHAN})


def test_plan_maps_rows_and_reports_session_fates() -> None:
    plan = _plan()
    pane = next(p for p in plan["panes"] if p["id"] == PANE)
    assert pane["active_mode"] == "claude-code" and pane["is_detached"] == 0 and pane["width_percent"] == 50.0
    adhoc = next(p for p in plan["panes"] if p["id"] != PANE)
    assert adhoc["width_percent"] == 100.0 and adhoc["is_detached"] == 1
    assert plan["project_settings"][0]["active_mode"] == "claude-code"
    assert plan["links"] == [
        {"session_id": LIVE, "pane_id": PANE, "mode": "claude-code", "kind": "legacy", "display_order": 0,
         "created_at": WHEN.isoformat(), "last_accessed_at": WHEN.isoformat()},
    ]
    fates = {entry["id"]: entry["result"] for entry in plan["sessions"]}
    assert fates == {LIVE: "legacy_link", STALE: "marked_dead", DEAD: "dead", ORPHAN: "running_without_pane"}
    tools = {tool["slug"]: tool for tool in plan["tools"]}
    assert tools["claude-code"]["aliases"] == ["claude"]
    assert "aliases" not in tools["pi"]


def test_apply_is_idempotent_and_keeps_existing_rows() -> None:
    plan = _plan()
    assert cli.apply_plan(plan) == {"panes": 2, "project_settings": 1, "links": 1}
    project_settings.upsert_settings("proj", display_order=9)  # a later user change survives a rerun
    assert cli.apply_plan(plan) == {"panes": 0, "project_settings": 0, "links": 0}
    assert project_settings.get_settings("proj")["display_order"] == 9  # type: ignore[index]
    link = pane_store.get_link(LIVE)
    assert link is not None and link["kind"] == "legacy" and link["pane_id"] == PANE


def test_run_migrate_dry_run_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("OLD_DB", "postgresql://example/ignored")
    monkeypatch.setattr(cli, "read_postgres", lambda url: _source())
    monkeypatch.setattr(cli, "_legacy_tmux_alive", lambda session_id: session_id == LIVE)
    db, tools = tmp_path / "v.db", tmp_path / "tools.json"
    args = ["migrate-from-postgres", "--database-url-env", "OLD_DB", "--db", str(db), "--tools-out", str(tools)]

    assert cli.main(args) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["mode"] == "dry-run" and report["legacy_links"] == 1 and "inserted" not in report
    assert "postgresql://" not in json.dumps(report)
    assert not db.exists() and not tools.exists()

    assert cli.main([*args, "--apply"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["inserted"] == {"panes": 2, "project_settings": 1, "links": 1}
    assert json.loads(tools.read_text())["tools"][0]["slug"] == "claude-code"
    assert oct(tools.stat().st_mode & 0o777) == "0o600"


def test_missing_database_url_is_a_clear_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("NOPE_DB", raising=False)
    monkeypatch.setattr(cli, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(cli.Path, "home", lambda: tmp_path)
    with pytest.raises(SystemExit, match="NOPE_DB is not set"):
        cli.resolve_database_url("NOPE_DB")


def test_database_url_falls_back_to_env_files(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("SOME_DB", raising=False)
    (tmp_path / ".env.local").write_text("OTHER=1\nexport SOME_DB='postgresql://u@h/db'\n")
    monkeypatch.setattr(cli, "REPO_ROOT", tmp_path)
    assert cli.resolve_database_url("SOME_DB") == "postgresql://u@h/db"


def test_missing_psycopg_explains_the_extra(monkeypatch: pytest.MonkeyPatch) -> None:
    real_import = builtins.__import__

    def no_psycopg(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "psycopg" or name.startswith("psycopg."):
            raise ImportError("No module named 'psycopg'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_psycopg)
    with pytest.raises(SystemExit, match="--extra migrate"):
        cli.read_postgres("postgresql://never-connected/")


# --- tool import ---------------------------------------------------------------


def test_plan_tool_import_actions() -> None:
    entries = _plan()["tools"]
    existing = {
        "claude-code": {"slug": "claude-code", "name": "Claude Code", "command": "claude --dangerously-skip-permissions",
                        "processName": "claude", "displayOrder": 0, "isDefault": False, "enabled": True},
        "pi": {"slug": "pi", "name": "Pi", "command": "pi --approve", "processName": "pi-coding-agent",
               "displayOrder": 5, "isDefault": False, "enabled": True},
    }
    existing["claude"] = existing["claude-code"]
    actions = {a["slug"]: a for a in cli.plan_tool_import(entries, existing, update_existing=False)}
    assert actions["claude-code"]["action"] == "unchanged"
    assert actions["pi"] == {"slug": "pi", "action": "differs", "fields": {"command": "pi"}}
    assert actions["mine"]["action"] == "create"
    updated = {a["slug"]: a for a in cli.plan_tool_import(entries, existing, update_existing=True)}
    assert updated["pi"]["action"] == "update"


def test_import_tools_dry_run_then_apply(
    fake_tether: FakeTether, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "tools.json"
    path.write_text(json.dumps({"tools": _plan()["tools"]}))

    assert cli.main(["import-tools", str(path)]) == 0
    dry = {a["slug"]: a["action"] for a in json.loads(capsys.readouterr().out)["actions"]}
    assert dry == {"claude-code": "unchanged", "pi": "differs", "mine": "create"}
    assert "mine" not in fake_tether.state.tools

    assert cli.main(["import-tools", str(path), "--apply"]) == 0
    capsys.readouterr()
    assert fake_tether.state.tools["mine"]["argv"] == ["mine", "--go"]
    assert fake_tether.state.tools["pi"]["argv"] == ["pi", "--approve"]  # existing tool left alone

    assert cli.main(["import-tools", str(path), "--apply", "--update-existing"]) == 0
    assert fake_tether.state.tools["pi"]["argv"] == ["pi"]
