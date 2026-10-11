"""A-Term's local view-state database (stdlib sqlite3).

Tether owns sessions. A-Term keeps only views here: panes and their layout,
which Tether sessions each pane shows, and per-project display settings.
Losing this file loses layout, never a running session.

The file lives at ``$A_TERM_DB_PATH``, else ``$A_TERM_STATE_DIR/a-term.db``,
else ``$XDG_STATE_HOME/a-term/a-term.db`` (``~/.local/state/a-term/a-term.db``).
Every call opens its own short connection; WAL keeps readers off the writer.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS panes (
    id             TEXT PRIMARY KEY,
    pane_type      TEXT NOT NULL CHECK (pane_type IN ('project', 'adhoc')),
    project_id     TEXT,
    pane_order     INTEGER NOT NULL DEFAULT 0,
    pane_name      TEXT NOT NULL,
    active_mode    TEXT NOT NULL DEFAULT 'shell',
    width_percent  REAL NOT NULL DEFAULT 100.0,
    height_percent REAL NOT NULL DEFAULT 100.0,
    grid_row       INTEGER NOT NULL DEFAULT 0,
    grid_col       INTEGER NOT NULL DEFAULT 0,
    is_detached    INTEGER NOT NULL DEFAULT 0 CHECK (is_detached IN (0, 1)),
    created_at     TEXT NOT NULL
);

-- One row per session a pane shows. session_id is a Tether session id, or for
-- kind='legacy' the UUID of a pre-Tether A-Term session that still runs on the
-- user's default tmux server (attach-only until it ends).
CREATE TABLE IF NOT EXISTS pane_sessions (
    session_id       TEXT PRIMARY KEY,
    pane_id          TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
    mode             TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'tether' CHECK (kind IN ('tether', 'legacy')),
    display_order    INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    last_accessed_at TEXT
);
CREATE INDEX IF NOT EXISTS pane_sessions_pane ON pane_sessions(pane_id);

CREATE TABLE IF NOT EXISTS project_settings (
    project_id    TEXT PRIMARY KEY,
    enabled       INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    display_order INTEGER NOT NULL DEFAULT 0,
    active_mode   TEXT NOT NULL DEFAULT 'shell',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
"""

_init_lock = threading.Lock()
_initialized: set[str] = set()


def default_db_path() -> Path:
    explicit = os.environ.get("A_TERM_DB_PATH", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    state_dir = os.environ.get("A_TERM_STATE_DIR", "").strip()
    if state_dir:
        return Path(state_dir).expanduser() / "a-term.db"
    xdg_state = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(xdg_state).expanduser() if xdg_state else Path.home() / ".local" / "state"
    return base / "a-term" / "a-term.db"


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


def _open(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, timeout=10.0, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


def initialize(path: Path | None = None) -> Path:
    """Create the file (0600, directory 0700) and schema if missing. Idempotent."""
    db_path = path or default_db_path()
    key = str(db_path)
    if key in _initialized and db_path.exists():
        return db_path
    with _init_lock:
        db_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        created = not db_path.exists()
        connection = _open(db_path)
        try:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(_SCHEMA)
            row = connection.execute("SELECT version FROM schema_version").fetchone()
            if row is None:
                connection.execute("INSERT INTO schema_version (version) VALUES (?)", (SCHEMA_VERSION,))
            elif row["version"] > SCHEMA_VERSION:
                raise RuntimeError(
                    f"{db_path} has schema {row['version']}, newer than this A-Term ({SCHEMA_VERSION})"
                )
        finally:
            connection.close()
        if created:
            os.chmod(db_path, 0o600)
        _initialized.add(key)
    return db_path


@contextmanager
def connect(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    """Autocommit connection for reads and single-statement writes."""
    db_path = initialize(path)
    connection = _open(db_path)
    try:
        yield connection
    finally:
        connection.close()


@contextmanager
def transaction(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    """``BEGIN IMMEDIATE`` transaction: one writer, committed on success."""
    db_path = initialize(path)
    connection = _open(db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
        except BaseException:
            connection.execute("ROLLBACK")
            raise
        connection.execute("COMMIT")
    finally:
        connection.close()


def reset_initialized_cache() -> None:
    """Forget which files were initialized (tests switch paths)."""
    _initialized.clear()
