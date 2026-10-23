"""Shared fixtures: a fake Tether on a real Unix socket and a throwaway SQLite file.

No test talks to the real Tether, the real tmux server, a real database or the real upload folder.
"""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Callable, Generator, Iterator
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from a_term.auth import AuthSettings
from a_term.storage import local_db
from a_term.tether import TetherClient, set_client

from .fake_tether import FakeTether

# The backend answers only a loopback Host (LoopbackHostGuard); TestClient's default is http://testserver.
LOOPBACK_BASE_URL = "http://localhost:8002"
# websocket_connect ignores base_url (always ws://testserver), so WebSocket tests pass this absolute URL.
LOOPBACK_WS_URL = "ws://localhost:8002"
# TestClient's default peer is "testclient"; production code trusts only real loopback peers, so tests say 127.0.0.1.
LOOPBACK_CLIENT = ("127.0.0.1", 50000)


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
def no_real_tether(monkeypatch: pytest.MonkeyPatch, local_state: Path) -> Iterator[None]:
    """By default Tether is absent; ``fake_tether`` points the client at a fake one.

    Also forgets the agent tokens Own tmux discovery cached from an earlier test.
    """
    from a_term.services import agent_tools

    monkeypatch.setenv("TETHER_SOCKET", str(local_state / "no-tether.sock"))
    agent_tools.reset_agent_tokens()
    yield
    agent_tools.reset_agent_tokens()


@pytest.fixture(autouse=True)
def no_real_uploads(local_state: Path) -> Iterator[None]:
    """A maintenance cycle prunes uploads in a throwaway folder, never the owner's real upload folder."""
    from a_term.services import maintenance
    from a_term.services.upload_cleanup import cleanup_old_uploads

    def cleanup(*_args: object, **kwargs: object) -> object:
        return cleanup_old_uploads(local_state / "uploads", **kwargs)

    with patch.object(maintenance, "cleanup_old_uploads", cleanup):
        yield


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
    monkeypatch.setenv("XDG_STATE_HOME", str(directory))
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
    """The default tmux server has no sessions (no Own tmux sessions)."""
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
    ):
        from a_term.main import app

        with TestClient(
            app, base_url=LOOPBACK_BASE_URL, client=LOOPBACK_CLIENT, raise_server_exceptions=False
        ) as client:
            yield client


@pytest.fixture()
def auth_settings(test_app: TestClient) -> Iterator[Callable[..., AuthSettings]]:
    """Switch the app's auth: password mode by default, ``**overrides`` change any field; undone after the test."""
    state = test_app.app.state
    original = state.trust

    def use(**overrides: object) -> AuthSettings:
        values: dict[str, object] = {
            "mode": "password",
            "password": "correct horse battery staple",
            "secret": "test-secret",
            "proxy_header": "X-Forwarded-User",
            "cookie_name": "a_term_session",
            "cookie_secure": False,
            "session_ttl_seconds": 3600,
        }
        values.update(overrides)
        settings = AuthSettings(**values)
        state.trust = replace(original, auth=settings)
        return settings

    yield use
    state.trust = original
