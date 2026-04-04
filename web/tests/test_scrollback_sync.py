from __future__ import annotations

import asyncio
import json

from terminal.services.scrollback_sync import (
    MAX_SCROLLBACK_CHARS,
    ScrollbackSyncOutputTracker,
    ScrollbackSyncScheduler,
    build_scrollback_sync_payload,
    limit_scrollback,
    normalize_scrollback,
)


def test_normalize_scrollback_converts_lf_without_duplicating_cr() -> None:
    assert normalize_scrollback("1\n2\r\n3\n") == "1\r\n2\r\n3\r\n"


def test_limit_scrollback_keeps_newest_complete_lines() -> None:
    scrollback = "line-1\nline-2\nline-3\nline-4\n"

    assert limit_scrollback(scrollback, max_chars=12) == "line-4\n"


def test_build_scrollback_sync_payload_trims_large_snapshots() -> None:
    repeated_line = "abcdefghij\n"
    scrollback = repeated_line * (MAX_SCROLLBACK_CHARS // len(repeated_line) + 5)

    payload = json.loads(build_scrollback_sync_payload(scrollback))

    assert payload["__ctrl"] is True
    assert len(payload["scrollback_sync"]) <= MAX_SCROLLBACK_CHARS
    assert payload["scrollback_sync"].endswith("abcdefghij\r\n")


def test_build_scrollback_sync_payload_includes_cursor_position() -> None:
    payload = json.loads(build_scrollback_sync_payload("line\n", (4, 9)))

    assert payload == {
        "__ctrl": True,
        "scrollback_sync": "line\r\n",
        "scrollback_cursor_x": 4,
        "scrollback_cursor_y": 9,
    }


def test_scrollback_sync_scheduler_debounces_to_latest_snapshot() -> None:
    sent_messages: list[str] = []
    latest_snapshot = {"value": "first\n"}

    class FakeWebSocket:
        async def send_text(self, payload: str) -> None:
            sent_messages.append(payload)

    async def run_test() -> None:
        scheduler = ScrollbackSyncScheduler(
            websocket=FakeWebSocket(),
            tmux_session_name="summitflow-test",
            delay_seconds=0.01,
            quiet_seconds=0.0,
            get_scrollback_with_cursor_fn=lambda _session_name: (
                latest_snapshot["value"],
                (2, 5),
            ),
        )
        scheduler.notify_output()
        await asyncio.sleep(0)
        latest_snapshot["value"] = "second\n"
        scheduler.notify_output()
        await asyncio.sleep(0.03)
        await scheduler.close()

    asyncio.run(run_test())

    assert len(sent_messages) == 1
    payload = json.loads(sent_messages[0])
    assert payload == {
        "__ctrl": True,
        "scrollback_sync": "second\r\n",
        "scrollback_cursor_x": 2,
        "scrollback_cursor_y": 5,
    }


def test_scrollback_sync_scheduler_limits_large_snapshots() -> None:
    sent_messages: list[str] = []

    class FakeWebSocket:
        async def send_text(self, payload: str) -> None:
            sent_messages.append(payload)

    async def run_test() -> None:
        scheduler = ScrollbackSyncScheduler(
            websocket=FakeWebSocket(),
            tmux_session_name="summitflow-test",
            delay_seconds=0.01,
            quiet_seconds=0.0,
            max_chars=12,
            get_scrollback_with_cursor_fn=lambda _session_name: (
                "line-1\nline-2\nline-3\nline-4\n",
                None,
            ),
        )
        scheduler.notify_output()
        await asyncio.sleep(0.03)
        await scheduler.close()

    asyncio.run(run_test())

    payload = json.loads(sent_messages[0])
    assert payload == {
        "__ctrl": True,
        "scrollback_sync": "line-4\r\n",
    }


def test_scrollback_sync_scheduler_suppressed_by_active_output() -> None:
    sent_messages: list[str] = []

    class FakeWebSocket:
        async def send_text(self, payload: str) -> None:
            sent_messages.append(payload)

    async def run_test() -> None:
        scheduler = ScrollbackSyncScheduler(
            websocket=FakeWebSocket(),
            tmux_session_name="summitflow-test",
            delay_seconds=0.01,
            get_scrollback_with_cursor_fn=lambda _session_name: ("content\n", None),
        )

        scheduler.notify_output()
        await asyncio.sleep(0.03)
        await scheduler.close()

    asyncio.run(run_test())

    assert len(sent_messages) == 1


def test_scrollback_sync_scheduler_waits_until_output_quiet_before_sending() -> None:
    sent_messages: list[str] = []

    class FakeWebSocket:
        async def send_text(self, payload: str) -> None:
            sent_messages.append(payload)

    async def run_test() -> None:
        scheduler = ScrollbackSyncScheduler(
            websocket=FakeWebSocket(),
            tmux_session_name="summitflow-test",
            delay_seconds=0.01,
            quiet_seconds=0.05,
            staleness_seconds=0,
            get_scrollback_with_cursor_fn=lambda _session_name: ("content\n", None),
        )
        tracker = ScrollbackSyncOutputTracker(scheduler, min_lines=5)
        scheduler.set_output_tracker(tracker)

        tracker.record_output("1\n2\n3\n4\n5\n")
        await asyncio.sleep(0.02)
        tracker.record_output("tail\n")
        await asyncio.sleep(0.08)
        await scheduler.close()

    asyncio.run(run_test())

    assert len(sent_messages) == 1
    payload = json.loads(sent_messages[0])
    assert payload == {
        "__ctrl": True,
        "scrollback_sync": "content\r\n",
    }


def test_scrollback_sync_output_tracker_waits_for_cumulative_threshold() -> None:
    notifications: list[str] = []

    class FakeScheduler:
        def notify_output(self) -> None:
            notifications.append("sync")

    tracker = ScrollbackSyncOutputTracker(FakeScheduler(), min_lines=5)

    tracker.record_output("1\n2\n")
    tracker.record_output("3\n4\n")

    assert notifications == []

    tracker.record_output("5\n")

    assert notifications == ["sync"]


def test_scrollback_sync_output_tracker_resets_after_trigger() -> None:
    notifications: list[str] = []

    class FakeScheduler:
        def notify_output(self) -> None:
            notifications.append("sync")

    tracker = ScrollbackSyncOutputTracker(FakeScheduler(), min_lines=3)

    tracker.record_output("1\n2\n3\n")
    tracker.record_output("4\n5\n")

    assert notifications == ["sync"]

    tracker.record_output("6\n")

    assert notifications == ["sync", "sync"]
