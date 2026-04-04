"""Tests for WebSocket backpressure controller (Phase 1)."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from terminal.services.backpressure import (
    HIGH_WATERMARK,
    LOW_WATERMARK,
    BackpressureController,
)


@pytest.fixture()
def loop():
    return MagicMock(spec=asyncio.AbstractEventLoop)


@pytest.fixture()
def on_readable():
    return MagicMock()


@pytest.fixture()
def controller(loop, on_readable):
    return BackpressureController(loop, master_fd=5, on_readable=on_readable)


class TestBackpressureController:
    def test_starts_unpaused(self, controller):
        assert not controller.paused

    def test_pause_at_high_watermark(self, controller, loop):
        controller.record_sent(HIGH_WATERMARK)
        assert controller.paused
        loop.remove_reader.assert_called_once_with(5)

    def test_resume_at_low_watermark(self, controller, loop, on_readable):
        controller.record_sent(HIGH_WATERMARK)
        assert controller.paused
        # Client commits enough to bring unacked below LWM
        controller.record_commit(HIGH_WATERMARK - LOW_WATERMARK + 1)
        assert not controller.paused
        loop.add_reader.assert_called_once_with(5, on_readable)

    def test_no_double_pause(self, controller, loop):
        controller.record_sent(HIGH_WATERMARK)
        controller.record_sent(1024)  # still above HWM
        assert controller.paused
        assert loop.remove_reader.call_count == 1

    def test_no_double_resume(self, controller, loop, on_readable):
        controller.record_sent(HIGH_WATERMARK)
        controller.record_commit(HIGH_WATERMARK)  # way below LWM
        controller.record_commit(HIGH_WATERMARK)  # duplicate commit
        assert not controller.paused
        assert loop.add_reader.call_count == 1

    def test_clamp_stale_commit(self, controller):
        """Commit value larger than total_sent should be clamped."""
        controller.record_sent(1000)
        controller.record_commit(999999)
        assert not controller.paused

    def test_close_idempotent(self, controller):
        controller.close()
        controller.close()  # should not raise

    def test_no_resume_after_close(self, controller, loop, on_readable):
        controller.record_sent(HIGH_WATERMARK)
        controller.close()
        controller.record_commit(HIGH_WATERMARK)
        # Should NOT call add_reader after close
        loop.add_reader.assert_not_called()

    def test_no_pause_after_close(self, controller, loop):
        controller.close()
        controller.record_sent(HIGH_WATERMARK * 2)
        loop.remove_reader.assert_not_called()

    def test_incremental_sends(self, controller, loop):
        chunk = HIGH_WATERMARK // 4
        for _ in range(3):
            controller.record_sent(chunk)
        assert not controller.paused
        controller.record_sent(chunk)  # now at HWM
        assert controller.paused
