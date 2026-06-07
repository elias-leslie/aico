"""Selection bus: a small SQLite ring buffer of cross-surface captures.

Sources POST their current selection here; the bus keeps only the most recent N.
Aico's main process reads it back over HTTP and inserts compact references into
the focused widget.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

RING_SIZE = 50
SNIPPET_CAP = 2000  # defensive server-side cap; sources should send far less
META_CAP = 4000  # serialized-JSON cap on meta, so it can't dwarf the snippet cap
VALID_KINDS = frozenset({"dom", "a11y", "region"})


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _row_to_record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "kind": row["kind"],
        "snippet": row["snippet"],
        "captured_at": row["captured_at"],
        "widget": row["widget"],
        "project": row["project"],
        "meta": json.loads(row["meta_json"]) if row["meta_json"] else {},
    }


class SelectionBus:
    """Append-only ring buffer of selections, backed by SQLite.

    Single-writer (the sidecar process); `check_same_thread=False` lets FastAPI's
    threadpool reach the one connection, and a lock serializes that one connection
    across the threadpool threads the sync endpoints run on. The ring is pruned to
    `RING_SIZE` on every push so the table never grows unbounded.
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._lock = threading.Lock()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS selections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                snippet TEXT NOT NULL,
                captured_at TEXT NOT NULL,
                widget TEXT,
                project TEXT,
                meta_json TEXT
            )
            """
        )
        self._conn.commit()

    def push(
        self,
        kind: str,
        snippet: str,
        meta: dict[str, Any] | None = None,
        widget: str | None = None,
        project: str | None = None,
    ) -> dict[str, Any]:
        """Append a capture and return the stored record (with `captured_at`)."""
        if kind not in VALID_KINDS:
            raise ValueError(f"invalid kind: {kind!r} (expected one of {sorted(VALID_KINDS)})")
        snippet = (snippet or "").strip()[:SNIPPET_CAP]
        meta_json = json.dumps(meta or {}, separators=(",", ":"))
        if len(meta_json) > META_CAP:
            raise ValueError(f"meta too large: {len(meta_json)} bytes (cap {META_CAP})")
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO selections (kind, snippet, captured_at, widget, project, meta_json)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (kind, snippet, _now_iso(), widget, project, meta_json),
            )
            # Keep only the most recent RING_SIZE rows (ids are monotonic).
            self._conn.execute(
                "DELETE FROM selections WHERE id <= (SELECT MAX(id) FROM selections) - ?",
                (RING_SIZE,),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM selections WHERE id = ?", (cur.lastrowid,)
            ).fetchone()
        return _row_to_record(row)

    def current(self) -> dict[str, Any] | None:
        """The newest capture, or None when the bus is empty."""
        with self._lock:
            row = self._conn.execute("SELECT * FROM selections ORDER BY id DESC LIMIT 1").fetchone()
        return _row_to_record(row) if row else None

    def history(self, n: int) -> list[dict[str, Any]]:
        """Up to `n` captures, newest first."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM selections ORDER BY id DESC LIMIT ?", (max(0, n),)
            ).fetchall()
        return [_row_to_record(r) for r in rows]

    def close(self) -> None:
        """Close the backing SQLite connection (called on app shutdown so a
        long-lived process — or each test app — doesn't leak the handle)."""
        with self._lock:
            self._conn.close()
