"""The metric history the trend checks read: one sqlite file with a value per metric, host, dimension and local day.

A check records a reading with record(): agg "last" keeps the day's latest
value, "max" its highest. Counts of events (corrected memory errors) are recorded as the day's count with agg "max"
(the count only grows during a day). Hosts are site roles ("pve", "workstation"), not host names. Daily rows are
pruned after DAILY_DAYS.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import time
from collections.abc import Sequence
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

log = logging.getLogger("host-steward")

DEFAULT_PATH = Path(
    os.environ.get("HOST_STEWARD_HISTORY") or "/var/lib/host-steward/history.sqlite3"
)
DAILY_DAYS = 3 * 366
SCHEMA = """
CREATE TABLE IF NOT EXISTS series (metric TEXT NOT NULL, host TEXT NOT NULL, kind TEXT NOT NULL, created REAL NOT NULL,
  coverage_start REAL, PRIMARY KEY (metric, host));
CREATE TABLE IF NOT EXISTS daily (metric TEXT NOT NULL, host TEXT NOT NULL, dim TEXT NOT NULL, day TEXT NOT NULL,
  value REAL NOT NULL, ts REAL NOT NULL, PRIMARY KEY (metric, host, dim, day));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def day_of(ts: float) -> str:
    return datetime.fromtimestamp(ts).date().isoformat()


class Store:
    def __init__(self, path: Path | str | None = None):
        self.path = Path(path) if path else DEFAULT_PATH
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=30)
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    def record(
        self,
        metric: str,
        host: str,
        value: float,
        dim: str = "",
        ts: float | None = None,
        agg: str = "last",
        kind: str = "gauge",
    ) -> None:
        """One reading for the day of ts. agg: 'last' keeps the latest reading of the day, 'max' the highest."""
        ts = time.time() if ts is None else ts
        with self.db:
            if (
                self.db.execute(
                    "SELECT 1 FROM series WHERE metric=? AND host=?", (metric, host)
                ).fetchone()
                is None
            ):
                self.db.execute(
                    "INSERT INTO series VALUES (?,?,?,?,?)", (metric, host, kind, ts, ts)
                )
            keep = "max(value, excluded.value)" if agg == "max" else "excluded.value"
            self.db.execute(
                "INSERT INTO daily VALUES (?,?,?,?,?,?) ON CONFLICT (metric, host, dim, day) DO UPDATE SET "
                f"value={keep}, ts=excluded.ts",
                (metric, host, dim, day_of(ts), float(value), ts),
            )
            cutoff = (date.fromtimestamp(ts) - timedelta(days=DAILY_DAYS)).isoformat()
            self.db.execute(
                "DELETE FROM daily WHERE metric=? AND host=? AND day<?", (metric, host, cutoff)
            )

    def series(self, metric: str, host: str) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT kind, created, coverage_start FROM series WHERE metric=? AND host=?",
            (metric, host),
        ).fetchone()
        return (
            None if row is None else {"kind": row[0], "created": row[1], "coverage_start": row[2]}
        )

    def daily(
        self, metric: str, host: str, dim: str | None = "", since_day: str = ""
    ) -> list[tuple[str, str, float]]:
        """(dim, day, value) ordered by dim then day; dim None returns every dimension."""
        query = "SELECT dim, day, value FROM daily WHERE metric=? AND host=? AND day>=?"
        args: list[Any] = [metric, host, since_day]
        if dim is not None:
            query += " AND dim=?"
            args.append(dim)
        return [
            (r[0], r[1], float(r[2])) for r in self.db.execute(query + " ORDER BY dim, day", args)
        ]

    def day_value(self, metric: str, host: str, day: str, dim: str = "") -> float:
        row = self.db.execute(
            "SELECT value FROM daily WHERE metric=? AND host=? AND dim=? AND day=?",
            (metric, host, dim, day),
        ).fetchone()
        return float(row[0]) if row else 0.0


def _marks(items: Sequence[Any]) -> str:
    return ",".join("?" for _ in items)


def store_for(cache: dict[str, Any]) -> Store:
    """The run's store (opened on first use, shared by the checks through ctx.cache). A test puts its own in cache."""
    if "history" not in cache:
        cache["history"] = Store()
    return cache["history"]


def record(
    cache: dict[str, Any],
    metric: str,
    host: str,
    value: float,
    dim: str = "",
    ts: float | None = None,
    agg: str = "last",
    kind: str = "gauge",
) -> None:
    """A check's reading into the run's store. A store that cannot be written never fails the check."""
    try:
        store_for(cache).record(metric, host, value, dim, ts, agg, kind)
    except (OSError, sqlite3.Error) as error:
        log.warning("history not written (%s): %s", metric, error)
