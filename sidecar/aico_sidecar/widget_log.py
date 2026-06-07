"""Structured per-widget JSONL logging.

Each widget gets its own append-only file at `<state>/logs/<widget-id>.jsonl`,
one JSON object per line. Widget ids map to tmux session names (`aico-<id>`) and
end up in a filesystem path, so they are validated against a strict charset to
keep them from escaping the logs directory.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# tmux widget ids are randomBytes(4) hex; allow the broader id-safe charset but
# nothing that could traverse paths (no dots, slashes, etc.).
_WIDGET_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Size-based rotation: when a widget's log passes this, roll it to `.1` (one
# backup, overwriting any prior). Keeps an append-only-feeling log from growing
# without bound over a long-lived widget while preserving recent history.
MAX_LOG_BYTES = 5 * 1024 * 1024


def is_valid_widget_id(widget_id: str) -> bool:
    return bool(_WIDGET_ID_RE.match(widget_id))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class WidgetLog:
    """Appends structured events to per-widget JSONL files under `logs_dir`."""

    def __init__(self, logs_dir: Path) -> None:
        self._logs_dir = logs_dir

    def path_for(self, widget_id: str) -> Path:
        return self._logs_dir / f"{widget_id}.jsonl"

    def append(self, widget_id: str, event: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        """Append one event line and return the record that was written."""
        if not is_valid_widget_id(widget_id):
            raise ValueError(f"invalid widget id: {widget_id!r}")
        record: dict[str, Any] = {"ts": _now_iso(), "widget_id": widget_id, "event": event}
        if data:
            record["data"] = data
        self._logs_dir.mkdir(parents=True, exist_ok=True)
        path = self.path_for(widget_id)
        self._rotate_if_needed(path)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, separators=(",", ":")) + "\n")
        return record

    def _rotate_if_needed(self, path: Path) -> None:
        """Roll `path` to `path.1` once it exceeds MAX_LOG_BYTES (single backup)."""
        try:
            if path.stat().st_size < MAX_LOG_BYTES:
                return
        except FileNotFoundError:
            return
        path.replace(path.with_suffix(path.suffix + ".1"))
