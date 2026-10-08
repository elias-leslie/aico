"""Tests for a_term session storage query construction."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from a_term.storage.sessions import list_sessions, update_root_name


def test_list_sessions_filters_detached_panes_with_qualified_session_columns() -> None:
    """Detached-pane filtering keeps a_term_sessions columns qualified."""
    with patch(
        "a_term.storage.sessions._execute_query",
        return_value=[],
    ) as execute_mock:
        list_sessions(include_dead=False, include_detached=False)

    query = execute_mock.call_args.args[0]
    assert "SELECT a_term_sessions.id, a_term_sessions.name" in query
    assert "WHERE a_term_sessions.is_alive = true" in query
    assert "COALESCE(a_term_panes.is_detached, false) = false" in query
    assert "ORDER BY a_term_sessions.display_order, a_term_sessions.created_at" in query


def test_list_sessions_include_dead_filters_detached_panes_with_qualified_ordering() -> None:
    """Dead-session listing still qualifies ordering after joining panes."""
    with patch(
        "a_term.storage.sessions._execute_query",
        return_value=[],
    ) as execute_mock:
        list_sessions(include_dead=True, include_detached=False)

    query = execute_mock.call_args.args[0]
    assert "SELECT a_term_sessions.id, a_term_sessions.name" in query
    assert "WHERE COALESCE(a_term_panes.is_detached, false) = false" in query
    assert "ORDER BY a_term_sessions.display_order, a_term_sessions.created_at" in query


def test_root_name_update_fences_exact_retained_session_and_generation() -> None:
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.fetchone.side_effect = [("session-1",), None]
    with patch("a_term.storage.sessions.get_connection") as connection:
        connection.return_value.__enter__.return_value = conn
        assert update_root_name("root-1", "session-1", "a" * 64, "Project · Focus") is True
        assert update_root_name("root-1", "session-1", "b" * 64, "Other") is False
    sql, params = cur.execute.call_args_list[0].args
    assert "UPDATE a_term_sessions SET name = %s" in sql
    assert "root.session_id = a_term_sessions.id" in sql
    assert "root.generation = %s AND root.launch_state = 'observed'" in sql
    assert params == ("Project · Focus", "root-1", "session-1", "a" * 64)
    assert conn.commit.call_count == 2
