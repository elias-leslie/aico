"""Tests for aterm/services/recording.py."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aterm.services.recording import SessionRecorder


@pytest.fixture
def recording_dir(tmp_path: Path) -> Path:
    d = tmp_path / "recordings"
    d.mkdir()
    return d


class TestSessionRecorder:
    @pytest.mark.asyncio
    async def test_record_and_drain(self, recording_dir: Path) -> None:
        rec = SessionRecorder("sess-1", recording_dir=recording_dir)
        rec.start()

        rec.record_output("hello world")
        rec.record_input("ls\n")
        rec.record_resize(120, 30)

        await rec.stop()

        assert rec.file_path.exists()
        lines = rec.file_path.read_text().strip().splitlines()
        assert len(lines) == 3

        evt0 = json.loads(lines[0])
        assert evt0["type"] == "output"
        assert evt0["data"] == "hello world"
        assert "t" in evt0

        evt1 = json.loads(lines[1])
        assert evt1["type"] == "input"

        evt2 = json.loads(lines[2])
        assert evt2["type"] == "resize"
        assert evt2["cols"] == 120

    @pytest.mark.asyncio
    async def test_record_sync(self, recording_dir: Path) -> None:
        rec = SessionRecorder("sess-2", recording_dir=recording_dir)
        rec.start()
        rec.record_sync(payload_size=4096, is_delta=True)
        await rec.stop()

        lines = rec.file_path.read_text().strip().splitlines()
        evt = json.loads(lines[0])
        assert evt["type"] == "sync"
        assert evt["is_delta"] is True

    @pytest.mark.asyncio
    async def test_size_limit(self, recording_dir: Path) -> None:
        rec = SessionRecorder(
            "sess-3",
            recording_dir=recording_dir,
            max_size_bytes=100,
        )
        rec.start()

        # Write enough to exceed limit
        for i in range(50):
            rec.record_output(f"line {i} " * 10)

        await rec.stop()
        assert rec.size_bytes <= 200  # small overshoot OK (one event)

    @pytest.mark.asyncio
    async def test_properties(self, recording_dir: Path) -> None:
        rec = SessionRecorder("sess-4", recording_dir=recording_dir)
        rec.start()
        rec.record_output("test")
        rec.record_resize(80, 24)
        await rec.stop()

        assert rec.event_count == 2
        assert rec.cols == 80
        assert rec.rows == 24
        assert rec.file_path.name.startswith("sess-4_")

    @pytest.mark.asyncio
    async def test_stop_idempotent(self, recording_dir: Path) -> None:
        rec = SessionRecorder("sess-5", recording_dir=recording_dir)
        rec.start()
        await rec.stop()
        await rec.stop()  # should not raise

    @pytest.mark.asyncio
    async def test_creates_dir_if_missing(self, tmp_path: Path) -> None:
        new_dir = tmp_path / "nested" / "recordings"
        rec = SessionRecorder("sess-6", recording_dir=new_dir)
        rec.start()
        rec.record_output("ok")
        await rec.stop()
        assert new_dir.is_dir()
        assert rec.file_path.exists()
