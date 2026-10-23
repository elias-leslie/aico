"""Local SQLite view-state file: location, permissions, schema."""

from __future__ import annotations

import stat
from pathlib import Path

import pytest

from a_term.storage import local_db


def test_explicit_path_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("A_TERM_DB_PATH", str(tmp_path / "x.db"))
    monkeypatch.setenv("A_TERM_STATE_DIR", str(tmp_path / "state"))
    assert local_db.default_db_path() == tmp_path / "x.db"


def test_state_dir_then_xdg(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("A_TERM_DB_PATH", raising=False)
    monkeypatch.setenv("A_TERM_STATE_DIR", str(tmp_path / "state"))
    assert local_db.default_db_path() == tmp_path / "state" / "a-term.db"
    monkeypatch.delenv("A_TERM_STATE_DIR")
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "xdg"))
    assert local_db.default_db_path() == tmp_path / "xdg" / "a-term" / "a-term.db"


def test_default_is_under_local_state(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("A_TERM_DB_PATH", "A_TERM_STATE_DIR", "XDG_STATE_HOME"):
        monkeypatch.delenv(name, raising=False)
    assert local_db.default_db_path() == Path.home() / ".local" / "state" / "a-term" / "a-term.db"


def test_initialize_creates_private_file_and_is_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "a-term.db"
    assert local_db.initialize(path) == path
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    local_db.reset_initialized_cache()
    local_db.initialize(path)
    with local_db.connect(path) as db:
        versions = db.execute("SELECT version FROM schema_version").fetchall()
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert [row[0] for row in versions] == [local_db.SCHEMA_VERSION]
    assert {"panes", "pane_sessions", "project_settings"} <= tables


def test_newer_schema_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "a-term.db"
    local_db.initialize(path)
    with local_db.connect(path) as db:
        db.execute("UPDATE schema_version SET version = ?", (local_db.SCHEMA_VERSION + 1,))
    local_db.reset_initialized_cache()
    with pytest.raises(RuntimeError, match="newer"):
        local_db.initialize(path)


def test_transaction_rolls_back_on_error(tmp_path: Path) -> None:
    path = tmp_path / "a-term.db"
    with pytest.raises(ValueError), local_db.transaction(path) as db:
        db.execute(
            "INSERT INTO project_settings (project_id, created_at, updated_at) VALUES ('p', 'x', 'x')"
        )
        raise ValueError("boom")
    with local_db.connect(path) as db:
        assert db.execute("SELECT COUNT(*) FROM project_settings").fetchone()[0] == 0
