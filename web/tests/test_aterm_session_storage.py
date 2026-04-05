"""Tests for aterm session storage query construction."""

from __future__ import annotations

from unittest.mock import patch

from aterm.storage.sessions import list_sessions


def test_list_sessions_filters_detached_panes_with_qualified_session_columns() -> None:
    """Detached-pane filtering keeps aterm_sessions columns qualified."""
    with patch(
        "aterm.storage.sessions._execute_query",
        return_value=[],
    ) as execute_mock:
        list_sessions(include_dead=False, include_detached=False)

    query = execute_mock.call_args.args[0]
    assert "SELECT aterm_sessions.id, aterm_sessions.name" in query
    assert "WHERE aterm_sessions.is_alive = true" in query
    assert "COALESCE(aterm_panes.is_detached, false) = false" in query
    assert "ORDER BY aterm_sessions.display_order, aterm_sessions.created_at" in query


def test_list_sessions_include_dead_filters_detached_panes_with_qualified_ordering() -> None:
    """Dead-session listing still qualifies ordering after joining panes."""
    with patch(
        "aterm.storage.sessions._execute_query",
        return_value=[],
    ) as execute_mock:
        list_sessions(include_dead=True, include_detached=False)

    query = execute_mock.call_args.args[0]
    assert "SELECT aterm_sessions.id, aterm_sessions.name" in query
    assert "WHERE COALESCE(aterm_panes.is_detached, false) = false" in query
    assert "ORDER BY aterm_sessions.display_order, aterm_sessions.created_at" in query
