"""Aico immutable tmux-server catalog discovery tests."""

from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import patch

import pytest

from a_term.utils.tmux import external as external_tmux


@pytest.fixture
def aico_state_dir() -> Iterator[Path]:
    # Keep the synthetic Unix socket paths below Linux's 108-byte sun_path cap.
    state_dir = Path(tempfile.mkdtemp(prefix="at-aico-", dir="/tmp"))
    yield state_dir
    shutil.rmtree(state_dir, ignore_errors=True)


def _create_catalog(state_dir: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(state_dir / "aico.db")
    connection.execute(
        """
        CREATE TABLE tmux_servers (
          id TEXT,
          kind TEXT,
          phase TEXT,
          socket_path TEXT,
          created_at INTEGER
        )
        """
    )
    return connection


def _managed_socket(state_dir: Path, server_id: str) -> str:
    return str(state_dir / "tmux" / server_id / "server.sock")


def _insert_server(
    connection: sqlite3.Connection,
    state_dir: Path,
    server_id: str,
    *,
    kind: str = "managed",
    phase: str = "active",
    socket_path: str | None = None,
    created_at: int = 1,
) -> None:
    connection.execute(
        "INSERT INTO tmux_servers VALUES (?, ?, ?, ?, ?)",
        (
            server_id,
            kind,
            phase,
            socket_path or _managed_socket(state_dir, server_id),
            created_at,
        ),
    )


def test_catalogued_sources_accept_only_active_managed_generation_layout(
    aico_state_dir: Path,
) -> None:
    valid_id = "1" * 32
    connection = _create_catalog(aico_state_dir)
    _insert_server(connection, aico_state_dir, valid_id)
    _insert_server(connection, aico_state_dir, "2" * 32, phase="dead", created_at=2)
    _insert_server(connection, aico_state_dir, "3" * 32, phase="provisioning", created_at=3)
    _insert_server(connection, aico_state_dir, "4" * 32, kind="legacy-observed", created_at=4)
    _insert_server(
        connection,
        aico_state_dir,
        "5" * 32,
        socket_path="/tmp/not-owned-by-the-generation/server.sock",
        created_at=5,
    )
    _insert_server(connection, aico_state_dir, "not-hex", created_at=6)
    connection.commit()
    connection.close()

    with patch.dict(os.environ, {"A_TERM_AICO_STATE_DIR": str(aico_state_dir)}):
        sources = external_tmux._catalogued_aico_tmux_sources()

    assert len(sources) == 1
    assert sources[0].id == f"aico-{valid_id}"
    assert sources[0].label == "Aico (11111111)"
    assert sources[0].socket_name == _managed_socket(aico_state_dir, valid_id)
    assert sources[0].session_prefix == "aico-"
    assert sources[0].include_shell is True


def test_catalogued_source_identity_distinguishes_same_session_on_two_sockets(
    aico_state_dir: Path,
) -> None:
    first_id = "1" * 32
    second_id = "2" * 32
    first_socket = _managed_socket(aico_state_dir, first_id)
    second_socket = _managed_socket(aico_state_dir, second_id)
    connection = _create_catalog(aico_state_dir)
    _insert_server(connection, aico_state_dir, first_id, created_at=1)
    _insert_server(connection, aico_state_dir, second_id, created_at=2)
    connection.commit()
    connection.close()

    def fake_run_tmux_command(args, check=False, socket_name=None):
        del check
        if args[:2] != ["list-panes", "-a"]:
            return False, "unexpected"
        if socket_name in {first_socket, second_socket}:
            return True, "aico-shared\t%1\t/home/testuser/aico\tbash"
        return False, "no server"

    with (
        patch.dict(os.environ, {"A_TERM_AICO_STATE_DIR": str(aico_state_dir)}),
        patch("a_term.utils.tmux.run_tmux_command", side_effect=fake_run_tmux_command),
        patch("a_term.utils.tmux.external._infer_project_id", return_value="aico"),
    ):
        sessions = external_tmux.list_external_tmux_sessions()

    assert [session["id"] for session in sessions] == [
        f"tmux:aico-{first_id}:aico-shared",
        f"tmux:aico-{second_id}:aico-shared",
    ]
    assert {session["tmux_socket"] for session in sessions} == {first_socket, second_socket}
    assert {session["tmux_source"] for session in sessions} == {
        f"aico-{first_id}",
        f"aico-{second_id}",
    }


def test_catalog_row_is_only_candidate_and_tmux_reply_controls_liveness(
    aico_state_dir: Path,
) -> None:
    server_id = "a" * 32
    private_socket = _managed_socket(aico_state_dir, server_id)
    connection = _create_catalog(aico_state_dir)
    _insert_server(connection, aico_state_dir, server_id)
    connection.commit()
    connection.close()

    calls: list[str | None] = []

    def unavailable_tmux(args, check=False, socket_name=None):
        del args, check
        calls.append(socket_name)
        return False, "no server running"

    with (
        patch.dict(os.environ, {"A_TERM_AICO_STATE_DIR": str(aico_state_dir)}),
        patch("a_term.utils.tmux.run_tmux_command", side_effect=unavailable_tmux),
    ):
        sessions = external_tmux.list_external_tmux_sessions()

    assert sessions == []
    assert private_socket in calls


def test_catalog_read_is_nonblocking_when_database_is_exclusively_locked(
    aico_state_dir: Path,
) -> None:
    server_id = "b" * 32
    connection = _create_catalog(aico_state_dir)
    _insert_server(connection, aico_state_dir, server_id)
    connection.commit()
    connection.execute("BEGIN EXCLUSIVE")

    try:
        with patch.dict(os.environ, {"A_TERM_AICO_STATE_DIR": str(aico_state_dir)}):
            assert external_tmux._catalogued_aico_tmux_sources() == ()
    finally:
        connection.rollback()
        connection.close()


def test_missing_or_old_aico_catalog_is_harmless(aico_state_dir: Path) -> None:
    sqlite3.connect(aico_state_dir / "aico.db").close()

    with patch.dict(os.environ, {"A_TERM_AICO_STATE_DIR": str(aico_state_dir)}):
        assert external_tmux._catalogued_aico_tmux_sources() == ()


def test_relative_aico_state_override_fails_closed() -> None:
    with patch.dict(os.environ, {"A_TERM_AICO_STATE_DIR": "relative/aico"}):
        assert external_tmux._catalogued_aico_tmux_sources() == ()
