"""Shared test fixtures for aterm backend tests.

Provides mock fixtures for database, tmux, and lifecycle operations
so that tests never hit production infrastructure.
"""

from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Database connection mock
# ---------------------------------------------------------------------------

@contextmanager
def _mock_get_connection() -> Generator[MagicMock]:
    """Fake database connection context manager.

    Returns a MagicMock that supports ``with get_connection() as conn``.
    """
    conn = MagicMock()
    yield conn


@pytest.fixture()
def mock_db_connection() -> Generator[MagicMock]:
    """Patch ``aterm.storage.connection.get_connection`` globally.

    Every storage function that opens a DB connection will receive a mock
    instead of a real psycopg connection.
    """
    with patch(
        "aterm.storage.connection.get_connection",
        side_effect=_mock_get_connection,
    ) as mock_conn:
        yield mock_conn


# ---------------------------------------------------------------------------
# Tmux operation mocks
# ---------------------------------------------------------------------------

@pytest.fixture()
def mock_tmux() -> Generator[dict[str, MagicMock]]:
    """Patch common tmux utility functions.

    Returns a dict keyed by function name so tests can configure
    return values per-function.
    """
    with (
        patch("aterm.utils.tmux.create_tmux_session") as mock_create,
        patch("aterm.utils.tmux.tmux_session_exists", return_value=True) as mock_exists,
        patch("aterm.utils.tmux.run_tmux_command", return_value=(True, "")) as mock_run,
        patch("aterm.utils.tmux.get_tmux_session_name", side_effect=lambda sid: f"summitflow-{sid}") as mock_name,
    ):
        yield {
            "create_tmux_session": mock_create,
            "tmux_session_exists": mock_exists,
            "run_tmux_command": mock_run,
            "get_tmux_session_name": mock_name,
        }


# ---------------------------------------------------------------------------
# Lifecycle mock
# ---------------------------------------------------------------------------

@pytest.fixture()
def mock_lifecycle() -> Generator[dict[str, MagicMock]]:
    """Patch lifecycle operations used by API endpoints."""
    with (
        patch("aterm.services.lifecycle.delete_session") as mock_delete,
        patch("aterm.services.lifecycle.reset_session") as mock_reset,
        patch("aterm.services.lifecycle.reset_all_sessions", return_value=0) as mock_reset_all,
        patch("aterm.services.lifecycle.reconcile_sessions", return_value={"reconciled": 0}) as mock_reconcile,
    ):
        yield {
            "delete_session": mock_delete,
            "reset_session": mock_reset,
            "reset_all_sessions": mock_reset_all,
            "reconcile_sessions": mock_reconcile,
        }


# ---------------------------------------------------------------------------
# FastAPI TestClient
# ---------------------------------------------------------------------------

@pytest.fixture()
def test_app(mock_lifecycle: dict[str, MagicMock]) -> Generator[TestClient]:
    """Create a FastAPI ``TestClient`` with mocked lifespan dependencies.

    The ``mock_lifecycle`` fixture is pulled in automatically so that the
    app startup reconciliation and tmux setup do not run against real
    infrastructure.
    """
    with (
        patch("aterm.main._setup_tmux_options"),
        patch("aterm.main.close_pool"),
        patch("aterm.main.start_scheduler"),
        patch("aterm.main.stop_scheduler"),
    ):
        from aterm.main import app

        with TestClient(app, raise_server_exceptions=False) as client:
            yield client
