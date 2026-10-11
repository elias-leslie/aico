"""Shared fixtures: a fake Tether on a real Unix socket and a throwaway SQLite file.

No test talks to the real Tether, the real tmux server or a real database.
"""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Generator, Iterator
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from a_term.storage import local_db
from a_term.tether import TetherClient, set_client

from .fake_tether import FakeTether


@pytest.fixture(autouse=True)
def local_state(monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Every test gets its own SQLite view-state file."""
    # Unix socket paths are length-limited, so keep these under /tmp.
    directory = Path(tempfile.mkdtemp(prefix="at-state-", dir="/tmp"))
    monkeypatch.setenv("A_TERM_DB_PATH", str(directory / "a-term.db"))
    local_db.reset_initialized_cache()
    try:
        yield directory
    finally:
        local_db.reset_initialized_cache()
        shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture(autouse=True)
def reset_rate_limits() -> Iterator[None]:
    """The in-memory rate limiter is process-wide; start every test fresh."""
    from a_term.rate_limit import limiter

    limiter.reset()
    yield


@pytest.fixture()
def fake_tether(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeTether]:
    """A running fake Tether that A-Term's client points at."""
    directory = Path(tempfile.mkdtemp(prefix="at-tether-", dir="/tmp"))
    fake = FakeTether(directory).start()
    monkeypatch.setenv("TETHER_SOCKET", fake.socket_path)
    set_client(TetherClient(fake.socket_path, timeout=5.0))
    try:
        yield fake
    finally:
        set_client(None)
        fake.stop()
        shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture()
def tether_down(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """Tether is not running: its socket does not exist."""
    directory = Path(tempfile.mkdtemp(prefix="at-tether-", dir="/tmp"))
    socket_path = str(directory / "control.sock")
    monkeypatch.setenv("TETHER_SOCKET", socket_path)
    set_client(TetherClient(socket_path, timeout=1.0))
    try:
        yield socket_path
    finally:
        set_client(None)
        shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture()
def no_default_tmux() -> Iterator[MagicMock]:
    """The default tmux server has no sessions (no legacy or external sessions)."""
    with patch("a_term.utils.tmux.run_tmux_command", return_value=(False, "no server running")) as run:
        yield run


@pytest.fixture()
def test_app(fake_tether: FakeTether, no_default_tmux: MagicMock) -> Generator[TestClient]:
    """The FastAPI app against the fake Tether, without the background workers."""
    with (
        patch("a_term.main.start_scheduler"),
        patch("a_term.main.stop_scheduler"),
        patch("a_term.main.start_watcher"),
        patch("a_term.main.stop_watcher"),
        patch("a_term.main._write_internal_token"),
        # Never touch the host's default tmux server from tests.
        patch("a_term.main._remove_legacy_session_switch_hook"),
    ):
        from a_term.main import app

        with TestClient(app, raise_server_exceptions=False) as client:
            yield client
