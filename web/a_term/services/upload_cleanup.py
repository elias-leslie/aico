"""Cleanup service for uploaded files.

Removes files from the upload directory that are older than a configured TTL.
Called during application startup to prevent unbounded disk usage.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass
from pathlib import Path

from ..config import UPLOAD_DIR, UPLOAD_MAX_AGE_SECONDS
from ..logging_config import get_logger

logger = get_logger(__name__)


@dataclass(slots=True)
class UploadCleanupStats:
    scanned_files: int = 0
    deleted_files: int = 0
    pruned_directories: int = 0
    errors: int = 0
    max_age_seconds: int = UPLOAD_MAX_AGE_SECONDS

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


def cleanup_old_uploads(
    upload_dir: Path = UPLOAD_DIR,
    max_age_seconds: int = UPLOAD_MAX_AGE_SECONDS,
) -> UploadCleanupStats:
    """Delete uploaded files older than max_age_seconds.

    Args:
        upload_dir: Directory containing uploaded files
        max_age_seconds: Maximum file age in seconds (default: 24 hours)

    Returns:
        Cleanup stats for observability
    """
    stats = UploadCleanupStats(max_age_seconds=max_age_seconds)
    if not upload_dir.exists():
        return stats

    cutoff = time.time() - max_age_seconds
    files_to_delete: list[Path] = []
    directories_to_check: set[Path] = set()

    for file_path in upload_dir.rglob("*"):
        if file_path.is_dir():
            directories_to_check.add(file_path)
            continue
        stats.scanned_files += 1
        try:
            if file_path.stat().st_mtime < cutoff:
                files_to_delete.append(file_path)
        except OSError as e:
            stats.errors += 1
            logger.warning("upload_cleanup_error", file=str(file_path), error=str(e))

    for file_path in files_to_delete:
        try:
            file_path.unlink(missing_ok=True)
            stats.deleted_files += 1
            directories_to_check.add(file_path.parent)
        except OSError as e:
            stats.errors += 1
            logger.warning("upload_cleanup_delete_error", file=str(file_path), error=str(e))

    for directory in sorted(directories_to_check, key=lambda path: len(path.parts), reverse=True):
        if directory == upload_dir or not directory.exists():
            continue
        try:
            next(directory.iterdir())
        except StopIteration:
            try:
                directory.rmdir()
                stats.pruned_directories += 1
            except OSError as e:
                stats.errors += 1
                logger.warning("upload_cleanup_prune_dir_error", directory=str(directory), error=str(e))
        except OSError as e:
            stats.errors += 1
            logger.warning("upload_cleanup_iterdir_error", directory=str(directory), error=str(e))

    logger.info("upload_cleanup_complete", **stats.to_dict())
    return stats
