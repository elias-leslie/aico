"""Per-run telemetry: how long each host-steward run took, how much CPU and memory it used, how it ended.

Port of ns/telemetry.py's run and step recording (the incident table and the status-page readers are not ported).
One small sqlite file beside the state file. `with telemetry.run("check") as r:` times a run; r.step("name") times a
part of it. A telemetry failure is printed and never fails the run; a run by a user who cannot write the file
(an agent's declare or lab-use) records nothing and says nothing. Old rows are pruned about once in 50 runs.
"""

from __future__ import annotations

import json
import os
import resource
import sqlite3
import time
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from host_steward import core

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, unit TEXT NOT NULL, started_at TEXT NOT NULL, wall_s REAL NOT NULL, cpu_s REAL NOT NULL,
  max_rss_kb INTEGER, status TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS runs_unit_started ON runs(unit, started_at);
CREATE TABLE IF NOT EXISTS steps (
  run_id INTEGER NOT NULL, name TEXT NOT NULL, wall_s REAL NOT NULL, cpu_s REAL NOT NULL, note TEXT);
CREATE INDEX IF NOT EXISTS steps_run ON steps(run_id);
"""
RUN_RETAIN_DAYS = 400  # overridable defaults
STEP_RETAIN_DAYS = 90
PRUNE_EVERY = 50


def db_path() -> Path:
    return core.STATE_PATH.with_name("telemetry.sqlite3")


def connect(path: Path | None = None) -> sqlite3.Connection:
    target = path or db_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(target, timeout=30)
    db.executescript(SCHEMA)
    return db


def _cpu() -> float:
    own, kids = (
        resource.getrusage(resource.RUSAGE_SELF),
        resource.getrusage(resource.RUSAGE_CHILDREN),
    )
    return own.ru_utime + own.ru_stime + kids.ru_utime + kids.ru_stime


@dataclass
class Run:
    """One measured run: set status ("ok", "error") and detail; time parts of it with step()."""

    unit: str
    status: str = "ok"
    detail: dict[str, Any] = field(default_factory=dict)
    steps: list[tuple[str, float, float, str]] = field(default_factory=list)

    @contextmanager
    def step(self, name: str, note: str = "") -> Generator[None]:
        wall, cpu = time.monotonic(), _cpu()
        try:
            yield
        finally:
            self.steps.append((name, time.monotonic() - wall, _cpu() - cpu, note[:200]))


@contextmanager
def run(unit: str, path: Path | None = None) -> Generator[Run]:
    """Records wall time, CPU (self and children), peak RSS and status for one run. Never raises on its own failure."""
    measured = Run(unit)
    started = datetime.now(UTC).isoformat(timespec="seconds")
    wall, cpu = time.monotonic(), _cpu()
    try:
        yield measured
    except BaseException:
        measured.status = "error"
        raise
    finally:
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        try:
            if _writable(path or db_path()):
                record(measured, started, time.monotonic() - wall, _cpu() - cpu, rss, path)
        except (sqlite3.Error, OSError) as error:
            print(f"telemetry: run not recorded: {error}")


def _writable(target: Path) -> bool:
    """The file, or for a first run its nearest existing parent, is writable by this process."""
    probe = target
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return os.access(probe, os.W_OK)


def record(
    measured: Run, started: str, wall: float, cpu: float, rss: int, path: Path | None = None
) -> None:
    db = connect(path)
    try:
        with db:
            cur = db.execute(
                "INSERT INTO runs(unit,started_at,wall_s,cpu_s,max_rss_kb,status,detail) VALUES(?,?,?,?,?,?,?)",
                (
                    measured.unit,
                    started,
                    round(wall, 3),
                    round(cpu, 3),
                    rss,
                    measured.status,
                    json.dumps(measured.detail, default=str) if measured.detail else None,
                ),
            )
            db.executemany(
                "INSERT INTO steps(run_id,name,wall_s,cpu_s,note) VALUES(?,?,?,?,?)",
                [
                    (cur.lastrowid, n, round(w, 3), round(c, 3), note or None)
                    for n, w, c, note in measured.steps
                ],
            )
            if cur.lastrowid and cur.lastrowid % PRUNE_EVERY == 0:
                prune(db, datetime.now(UTC))
    finally:
        db.close()


def prune(db: sqlite3.Connection, now: datetime) -> None:
    """Drops step rows past STEP_RETAIN_DAYS and run rows past RUN_RETAIN_DAYS (this file's own history only)."""
    old_steps = (now - timedelta(days=STEP_RETAIN_DAYS)).isoformat()
    db.execute(
        "DELETE FROM steps WHERE run_id IN (SELECT id FROM runs WHERE started_at < ?)", (old_steps,)
    )
    db.execute(
        "DELETE FROM runs WHERE started_at < ?",
        ((now - timedelta(days=RUN_RETAIN_DAYS)).isoformat(),),
    )
