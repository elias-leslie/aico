from __future__ import annotations

import asyncio

import pytest

from terminal.services._pty_reader import (
    BATCH_SIZE_LIMIT,
    _has_incomplete_escape,
    _make_on_readable,
    _run_one_iteration,
)


def test_make_on_readable_enqueues_all_output(monkeypatch) -> None:
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    on_readable = _make_on_readable(123, queue, session_id="session-1")

    monkeypatch.setattr(
        "terminal.services._pty_reader._read_pty_data",
        lambda _master_fd: b"hello",
    )

    on_readable()

    assert queue.get_nowait() == b"hello"


def test_make_on_readable_enqueues_eof(monkeypatch) -> None:
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    on_readable = _make_on_readable(123, queue, session_id="session-1")

    monkeypatch.setattr(
        "terminal.services._pty_reader._read_pty_data",
        lambda _master_fd: None,
    )

    on_readable()

    assert queue.get_nowait() is None


# Phase 7: Output coalescing — incomplete escape sequence detection
class TestHasIncompleteEscape:
    def test_plain_text(self) -> None:
        assert not _has_incomplete_escape("hello world")

    def test_no_escape(self) -> None:
        assert not _has_incomplete_escape("no escape here")

    def test_complete_csi(self) -> None:
        assert not _has_incomplete_escape("text\x1b[31m")

    def test_incomplete_csi_no_terminator(self) -> None:
        assert _has_incomplete_escape("text\x1b[31")

    def test_incomplete_bare_esc(self) -> None:
        assert _has_incomplete_escape("text\x1b")

    def test_complete_osc_with_bel(self) -> None:
        assert not _has_incomplete_escape("text\x1b]0;title\x07")

    def test_incomplete_osc(self) -> None:
        assert _has_incomplete_escape("text\x1b]0;tit")

    def test_complete_osc_with_st(self) -> None:
        assert not _has_incomplete_escape("text\x1b]0;title\x1b\\")

    def test_incomplete_dcs(self) -> None:
        assert _has_incomplete_escape("text\x1bPdata")

    def test_complete_dcs(self) -> None:
        assert not _has_incomplete_escape("text\x1bPdata\x1b\\")

    def test_esc_followed_by_letter(self) -> None:
        """Single-char escape (e.g. ESC M for reverse index) — complete."""
        assert not _has_incomplete_escape("text\x1bM")

    def test_empty_string(self) -> None:
        assert not _has_incomplete_escape("")

    def test_csi_with_params_complete(self) -> None:
        """CSI with semicolons and terminator."""
        assert not _has_incomplete_escape("\x1b[38;5;196m")

    def test_csi_with_params_incomplete(self) -> None:
        """CSI with semicolons but no terminator."""
        assert _has_incomplete_escape("\x1b[38;5;196")


class TestBatchDoesNotSplitEscapes:
    """Verify that a batch hitting BATCH_SIZE_LIMIT is NOT flushed when it
    ends with an incomplete escape sequence (Fix 1 for TUI repaint corruption)."""

    @pytest.mark.asyncio
    async def test_size_limit_with_incomplete_escape_holds_batch(self) -> None:
        """When the batch is >= 4KB but ends with an incomplete CSI, the
        iteration must NOT flush — it should hold for the next chunk."""
        flushed: list[str] = []

        class FakeWebSocket:
            async def send_bytes(self, data: bytes) -> None:
                flushed.append(data.decode("utf-8", errors="replace"))

            async def send_text(self, data: str) -> None:
                flushed.append(data)

        queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        loop = asyncio.get_event_loop()

        # Build a payload that exceeds BATCH_SIZE_LIMIT but ends with an
        # incomplete CSI escape (\x1b[12;1 — missing the terminator 'H').
        padding = "x" * (BATCH_SIZE_LIMIT - 10)
        incomplete_csi = "\x1b[12;1"
        raw = (padding + incomplete_csi).encode("utf-8")

        # Put data in queue; queue will be empty after get(), triggering
        # the flush check.
        queue.put_nowait(raw)

        state = {"batch": "", "flush_time": 0.0, "running": True, "utf8": b""}
        await _run_one_iteration(
            FakeWebSocket(), queue, loop, state, wait_time=0.1, use_binary=False
        )

        # The batch should NOT have been flushed — it's held.
        assert len(flushed) == 0
        assert state["batch"] == padding + incomplete_csi

    @pytest.mark.asyncio
    async def test_size_limit_with_complete_escape_flushes(self) -> None:
        """When the batch is >= 4KB and ends with a COMPLETE escape, flush
        normally."""
        flushed: list[str] = []

        class FakeWebSocket:
            async def send_bytes(self, data: bytes) -> None:
                flushed.append(data.decode("utf-8", errors="replace"))

            async def send_text(self, data: str) -> None:
                flushed.append(data)

        queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        loop = asyncio.get_event_loop()

        padding = "x" * (BATCH_SIZE_LIMIT - 10)
        complete_csi = "\x1b[12;1H"
        raw = (padding + complete_csi).encode("utf-8")

        queue.put_nowait(raw)

        state = {"batch": "", "flush_time": 0.0, "running": True, "utf8": b""}
        await _run_one_iteration(
            FakeWebSocket(), queue, loop, state, wait_time=0.1, use_binary=False
        )

        # The batch SHOULD have been flushed — escape is complete.
        assert len(flushed) == 1
        assert state["batch"] == ""
