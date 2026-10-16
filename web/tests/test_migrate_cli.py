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
    return cli.build_plan(_source(), {"claude": "claude-code"})


def test_plan_maps_rows() -> None:
    plan = _plan()
    pane = next(p for p in plan["panes"] if p["id"] == PANE)
    assert pane["active_mode"] == "claude-code" and pane["is_detached"] == 0 and pane["width_percent"] == 50.0
    adhoc = next(p for p in plan["panes"] if p["id"] != PANE)
    assert adhoc["width_percent"] == 100.0 and adhoc["is_detached"] == 1
    assert plan["project_settings"][0]["active_mode"] == "claude-code"
    assert set(plan) == {"panes", "project_settings", "tools"}  # pre-Tether sessions are not copied
    tools = {tool["slug"]: tool for tool in plan["tools"]}
    assert tools["claude-code"]["aliases"] == ["claude"]
    assert "aliases" not in tools["pi"]


def test_apply_is_idempotent_and_keeps_existing_rows() -> None:
    plan = _plan()
    assert cli.apply_plan(plan) == {"panes": 2, "project_settings": 1}
    project_settings.upsert_settings("proj", display_order=9)  # a later user change survives a rerun
    assert cli.apply_plan(plan) == {"panes": 0, "project_settings": 0}
    assert project_settings.get_settings("proj")["display_order"] == 9  # type: ignore[index]
    assert pane_store.list_links() == []


def test_slug_renames_come_from_tethers_aliases(fake_tether: FakeTether) -> None:
    fake_tether.state.tools["codex"]["aliases"] = ["openai-codex"]
    assert cli.tool_slug_renames() == {"claude": "claude-code", "openai-codex": "codex"}


def test_migrate_refuses_clearly_when_tether_is_down(tether_down: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLD_DB", "postgresql://example/ignored")
    monkeypatch.setattr(cli, "read_postgres", lambda url: _source())
    with pytest.raises(SystemExit, match="can't read Tether's tool registry"):
        cli.main(["migrate-from-postgres", "--database-url-env", "OLD_DB"])


def test_run_migrate_dry_run_writes_nothing(
    fake_tether: FakeTether, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("OLD_DB", "postgresql://example/ignored")
    monkeypatch.setattr(cli, "read_postgres", lambda url: _source())
    db, tools = tmp_path / "v.db", tmp_path / "tools.json"
    args = ["migrate-from-postgres", "--database-url-env", "OLD_DB", "--db", str(db), "--tools-out", str(tools)]

    assert cli.main(args) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["mode"] == "dry-run" and "legacy_links" not in report and "inserted" not in report
    assert "postgresql://" not in json.dumps(report)
    assert not db.exists() and not tools.exists()

    assert cli.main([*args, "--apply"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["inserted"] == {"panes": 2, "project_settings": 1}
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


def test_tool_input_leaves_out_unset_fields() -> None:
    entries = {entry["slug"]: cli.tether_tool_input(entry) for entry in _plan()["tools"]}
    assert "description" not in entries["pi"] and "color" not in entries["pi"]
    assert entries["claude-code"]["aliases"] == ["claude"]
    assert entries["mine"]["description"] == "x"


def test_import_tools_dry_run_then_apply(
    fake_tether: FakeTether, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "tools.json"
    path.write_text(json.dumps({"tools": _plan()["tools"]}))

    assert cli.main(["import-tools", str(path)]) == 0
    dry = json.loads(capsys.readouterr().out)
    assert dry["mode"] == "dry-run" and dry["applied"] is False
    assert dry["created"] == ["mine"] and dry["unchanged"] == ["claude-code"]
    assert dry["differs"] == [{"slug": "pi", "fields": ["argv"]}]
    assert "mine" not in fake_tether.state.tools
    method, path_called, body = fake_tether.calls[-1]
    assert (method, path_called) == ("POST", "/v1/tools/import")
    assert body["dryRun"] is True and body["updateExisting"] is False

    assert cli.main(["import-tools", str(path), "--apply"]) == 0
    capsys.readouterr()
    assert fake_tether.state.tools["mine"]["argv"] == ["mine", "--go"]
    assert fake_tether.state.tools["pi"]["argv"] == ["pi", "--approve"]  # existing tool left alone

    assert cli.main(["import-tools", str(path), "--apply", "--update-existing"]) == 0
    assert json.loads(capsys.readouterr().out)["updated"] == ["pi"]
    assert fake_tether.state.tools["pi"]["argv"] == ["pi"]


def test_import_tools_rejected_batch_writes_nothing(
    fake_tether: FakeTether, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "tools.json"
    path.write_text(json.dumps([{"slug": "ok", "name": "Ok", "command": "ok"}, {"slug": "bad"}]))
    assert cli.main(["import-tools", str(path), "--apply"]) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "invalid_body"
    assert "ok" not in fake_tether.state.tools
