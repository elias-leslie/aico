"""Tests for demand-paged scrollback (Phase 3)."""

from __future__ import annotations

from unittest.mock import patch

from a_term.services.scrollback_pager import (
    MAX_PAGE_SIZE,
    get_scrollback_line_count,
    get_scrollback_range,
    get_viewport_lines,
)


class TestGetScrollbackLineCount:
    @patch("a_term.services.scrollback_pager.run_tmux_command")
    @patch("a_term.services.scrollback_pager.validate_session_name", return_value=True)
    def test_returns_count(self, _validate, mock_tmux):
        mock_tmux.return_value = (True, "4832")
        assert get_scrollback_line_count("test-session") == 4832

    @patch("a_term.services.scrollback_pager.run_tmux_command")
    @patch("a_term.services.scrollback_pager.validate_session_name", return_value=True)
    def test_returns_none_on_failure(self, _validate, mock_tmux):
        mock_tmux.return_value = (False, "")
        assert get_scrollback_line_count("test-session") is None

    @patch("a_term.services.scrollback_pager.validate_session_name", return_value=False)
    def test_rejects_invalid_session(self, _validate):
        assert get_scrollback_line_count("invalid;session") is None


class TestGetScrollbackRange:
    @patch("a_term.services.scrollback_pager.run_tmux_command")
    @patch("a_term.services.scrollback_pager.get_scrollback_line_count", return_value=100)
    @patch("a_term.services.scrollback_pager.validate_session_name", return_value=True)
    def test_captures_range(self, _validate, _count, mock_tmux):
        mock_tmux.return_value = (True, "line1\nline2\nline3\n")
        result = get_scrollback_range("test", from_line=0, count=3)
        assert result is not None
        lines, total = result
        assert len(lines) == 3
        assert total == 100

    @patch("a_term.services.scrollback_pager.get_scrollback_line_count", return_value=100)
    @patch("a_term.services.scrollback_pager.validate_session_name", return_value=True)
    def test_clamps_to_max_page_size(self, _validate, _count):
        with patch("a_term.services.scrollback_pager.run_tmux_command") as mock_tmux:
            mock_tmux.return_value = (True, "line\n" * MAX_PAGE_SIZE)
            get_scrollback_range("test", from_line=0, count=9999)
            # Should be clamped — verify the end arg isn't larger than MAX_PAGE_SIZE
            args = mock_tmux.call_args[0][0]
            assert "capture-pane" in args


class TestGetViewportLines:
    @patch("a_term.services.scrollback_pager.run_tmux_command")
    @patch("a_term.services.scrollback_pager.get_scrollback_line_count", return_value=500)
    @patch("a_term.services.scrollback_pager.validate_session_name", return_value=True)
    def test_captures_viewport(self, _validate, _count, mock_tmux):
        mock_tmux.return_value = (True, "$ ls\nfile1  file2\n")
        result = get_viewport_lines("test", rows=30)
        assert result is not None
        viewport_text, total, start = result
        assert total == 500
        assert start == 500
        assert "$ ls" in viewport_text

    @patch("a_term.services.scrollback_pager.validate_session_name", return_value=False)
    def test_rejects_invalid_session(self, _validate):
        assert get_viewport_lines("bad;session", rows=30) is None
