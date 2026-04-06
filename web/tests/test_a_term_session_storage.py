"""Tests for a_term session storage query construction."""

from __future__ import annotations

from unittest.mock import patch

from a_term.storage.sessions import list_sessions


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
