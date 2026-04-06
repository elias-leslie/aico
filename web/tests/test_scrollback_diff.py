"""Tests for line-level diff scrollback sync (Phase 2)."""

from __future__ import annotations

from a_term.services.scrollback_sync import LineDiffTracker, _split_lines


class TestSplitLines:
    def test_splits_on_newline(self):
        assert _split_lines("a\nb\nc") == ["a", "b", "c"]

    def test_strips_trailing_empty(self):
        assert _split_lines("a\nb\n") == ["a", "b"]

    def test_empty_string(self):
        assert _split_lines("") == []


class TestLineDiffTracker:
    def test_first_delta_all_changes(self):
        tracker = LineDiffTracker()
        delta = tracker.compute_delta("line1\nline2\nline3")
        assert delta.seqno == 1
        assert len(delta.changes) == 3
        assert delta.removals == []
        assert delta.total_lines == 3

    def test_identical_content_empty_delta(self):
        tracker = LineDiffTracker()
        tracker.compute_delta("line1\nline2")
        delta = tracker.compute_delta("line1\nline2")
        assert delta.changes == []
        assert delta.removals == []

    def test_appended_lines(self):
        tracker = LineDiffTracker()
        tracker.compute_delta("line1\nline2")
        delta = tracker.compute_delta("line1\nline2\nline3")
        assert len(delta.changes) == 1
        assert delta.changes[0] == (2, "line3")

    def test_modified_middle_line(self):
        tracker = LineDiffTracker()
        tracker.compute_delta("aaa\nbbb\nccc")
        delta = tracker.compute_delta("aaa\nBBB\nccc")
        assert len(delta.changes) == 1
        assert delta.changes[0][1] == "BBB"

    def test_head_truncation(self):
        tracker = LineDiffTracker()
        tracker.compute_delta("old1\nold2\nold3\nold4")
        delta = tracker.compute_delta("old3\nold4\nnew5")
        # old1 and old2 scrolled off
        assert len(delta.removals) >= 2
        assert delta.base_offset == 2

    def test_stable_index_correctness(self):
        tracker = LineDiffTracker()
        d1 = tracker.compute_delta("a\nb\nc")
        assert d1.base_offset == 0
        assert d1.changes[0] == (0, "a")
        assert d1.changes[2] == (2, "c")

    def test_full_sync_cheaper_threshold(self):
        tracker = LineDiffTracker()
        tracker.compute_delta("a\nb\nc\nd")
        # Change more than half the lines
        delta = tracker.compute_delta("X\nY\nZ\nd")
        assert delta.is_full_sync_cheaper  # 3 changes > 4//2

    def test_cursor_passthrough(self):
        tracker = LineDiffTracker()
        delta = tracker.compute_delta("test", cursor=(5, 10))
        assert delta.cursor == (5, 10)

    def test_seqno_increments(self):
        tracker = LineDiffTracker()
        d1 = tracker.compute_delta("a")
        d2 = tracker.compute_delta("b")
        d3 = tracker.compute_delta("c")
        assert d1.seqno == 1
        assert d2.seqno == 2
        assert d3.seqno == 3

    def test_reset_clears_state(self):
        tracker = LineDiffTracker()
        tracker.compute_delta("a\nb")
        tracker.reset()
        delta = tracker.compute_delta("a\nb")
        # After reset, first delta should have all lines as changes
        assert len(delta.changes) == 2
        assert delta.seqno == 1

    def test_to_dict_format(self):
        tracker = LineDiffTracker()
        delta = tracker.compute_delta("test\nline", cursor=(3, 1))
        d = delta.to_dict()
        assert d["__ctrl"] is True
        assert "scrollback_delta" in d
        sd = d["scrollback_delta"]
        assert sd["seqno"] == 1
        assert sd["base"] == 0
        assert sd["cursor"] == [3, 1]

    def test_tail_removal(self):
        """Lines removed from the tail (window shrink)."""
        tracker = LineDiffTracker()
        tracker.compute_delta("a\nb\nc\nd")
        delta = tracker.compute_delta("a\nb")
        # c and d were removed
        removal_indices = delta.removals
        assert 2 in removal_indices
        assert 3 in removal_indices
