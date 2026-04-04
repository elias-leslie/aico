"""Tests for upload cleanup maintenance behavior."""

from __future__ import annotations

import os
import time
from pathlib import Path

from terminal.services.upload_cleanup import cleanup_old_uploads


def _write_file(path: Path, *, age_seconds: int = 0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("data")
    if age_seconds:
        old_time = time.time() - age_seconds
        os.utime(path, (old_time, old_time))


def test_cleanup_old_uploads_recursively_deletes_old_files_and_prunes_dirs(
    tmp_path: Path,
) -> None:
    """Old nested uploads are removed and empty directories are pruned."""
    old_file = tmp_path / "nested" / "old.txt"
    fresh_file = tmp_path / "fresh.txt"
    _write_file(old_file, age_seconds=3600)
    _write_file(fresh_file, age_seconds=10)

    stats = cleanup_old_uploads(tmp_path, max_age_seconds=300)

    assert stats.scanned_files == 2
    assert stats.deleted_files == 1
    assert stats.pruned_directories == 1
    assert stats.errors == 0
    assert not old_file.exists()
    assert fresh_file.exists()
    assert not (tmp_path / "nested").exists()


def test_cleanup_old_uploads_missing_dir_returns_zero_stats(tmp_path: Path) -> None:
    """Missing upload directories should not raise or report deletions."""
    stats = cleanup_old_uploads(tmp_path / "missing", max_age_seconds=60)

    assert stats.scanned_files == 0
    assert stats.deleted_files == 0
    assert stats.pruned_directories == 0
    assert stats.errors == 0
