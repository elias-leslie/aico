"""30-day usage evidence: what ran, and when it was last seen, in a sqlite file. Never pruned.

Port of ns/checks/usage.py. Sources: systemd unit timestamps (system and the owner's user manager), /proc process
samples (cheap, taken on every check pass) and process accounting through lastcomm when acct is installed. The schema
is Nightshift's; the file starts fresh. Paths, owners and the staleness line are in checks.toml [checks.usage].
"""

from __future__ import annotations

import os
import pwd
import sqlite3
import subprocess
import threading
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from host_steward import core
from host_steward.checks.workstation import user_systemctl

SCHEMA = """
CREATE TABLE IF NOT EXISTS exec_seen (
  source TEXT NOT NULL, name TEXT NOT NULL, user TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, samples INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, name, user));
CREATE TABLE IF NOT EXISTS unit_seen (
  manager TEXT NOT NULL, unit TEXT NOT NULL, first_snapshot TEXT NOT NULL, last_snapshot TEXT NOT NULL,
  active_state TEXT, last_active_enter TEXT, last_inactive_enter TEXT,
  PRIMARY KEY (manager, unit));
CREATE TABLE IF NOT EXISTS runs (ts TEXT NOT NULL, kind TEXT NOT NULL, rows INTEGER NOT NULL);
"""
UNIT_TYPES = (".service", ".timer", ".socket", ".path")
MONTHS = {
    month: number
    for number, month in enumerate(
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1
    )
}


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.executescript(SCHEMA)
    return db


def upsert_execs(db: sqlite3.Connection, source: str, rows: Iterable[tuple[str, str, str]]) -> int:
    """rows: (name, user, iso time). last_seen only moves forward; first_seen only backward."""
    n = 0
    for name, user, ts in rows:
        db.execute(
            """INSERT INTO exec_seen(source,name,user,first_seen,last_seen,samples) VALUES(?,?,?,?,?,1)
               ON CONFLICT(source,name,user) DO UPDATE SET
                 last_seen=max(last_seen, excluded.last_seen), first_seen=min(first_seen, excluded.first_seen),
                 samples=samples+1""",
            (source, name, user, ts, ts),
        )
        n += 1
    return n


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat(timespec="seconds")


def parse_lastcomm_lines(lines: Iterable[str], now: datetime) -> dict[tuple[str, str], str]:
    """`lastcomm` lines -> {(command, user): latest time as UTC ISO}. The dates have no year."""
    latest: dict[tuple[str, str], str] = {}
    local_tz = datetime.now().astimezone().tzinfo
    for line in lines:
        cmd = line[:16].strip()
        tok = line[16:].split()
        if not cmd or len(tok) < 8 or tok[-5] != "secs" or tok[-3] not in MONTHS:
            continue
        hh, _, mm = tok[-1].partition(":")
        try:
            ts = datetime(
                now.year, MONTHS[tok[-3]], int(tok[-2]), int(hh), int(mm), tzinfo=local_tz
            )
        except ValueError:
            continue
        if ts - now > timedelta(days=1):  # December entries read in January
            ts = ts.replace(year=ts.year - 1)
        iso = ts.astimezone(UTC).isoformat(timespec="seconds")
        key = (cmd, tok[-8])
        if iso > latest.get(key, ""):
            latest[key] = iso
    return latest


def _drop_cache(path: str) -> None:
    """Drops the file's clean page-cache pages: a cold half-gigabyte pacct read once a day would otherwise push out
    pages the desktop uses."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
    except OSError:
        pass
    finally:
        os.close(fd)


def _dropping_cache(lines: Iterable[str], path: str, every: int = 100_000) -> Iterator[str]:
    for i, line in enumerate(lines, 1):
        if i % every == 0:
            _drop_cache(path)
        yield line


def stream_lastcomm(
    pacct: str, now: datetime, timeout: float
) -> tuple[int, dict[tuple[str, str], str]]:
    """(exit code, parsed) for `lastcomm -f pacct`, read line by line (a 468 MB pacct prints about 0.5 GB of text).
    124 = killed at timeout, 127 = no lastcomm. A failed or timed-out read keeps the lines it parsed."""
    env = {**os.environ, "LC_ALL": "C"}
    try:
        proc = subprocess.Popen(
            ["lastcomm", "-f", pacct], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            errors="replace", env=env,
        )  # fmt: skip
    except FileNotFoundError:
        return 127, {}
    killed = threading.Event()

    def kill() -> None:
        killed.set()
        proc.kill()

    timer = threading.Timer(timeout, kill)
    timer.start()
    try:
        assert proc.stdout is not None
        with proc.stdout:
            parsed = parse_lastcomm_lines(_dropping_cache(proc.stdout, pacct), now)
        rc = proc.wait()
    finally:
        timer.cancel()
        _drop_cache(pacct)
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    return (124 if killed.is_set() and rc < 0 else rc), parsed


def sample_proc(proc: Path = Path("/proc")) -> set[tuple[str, str]]:
    """(exe path or comm, user) for every userspace process visible now."""
    seen = set()
    users: dict[int, str] = {}
    for pid_dir in proc.iterdir():
        if not pid_dir.name.isdigit():
            continue
        try:
            uid = pid_dir.stat().st_uid
            try:
                name = os.readlink(pid_dir / "exe").removesuffix(" (deleted)")
            except OSError:
                if not (pid_dir / "cmdline").read_bytes():
                    continue  # kernel thread
                name = (pid_dir / "comm").read_text().strip()
        except OSError:
            continue
        if uid not in users:
            try:
                users[uid] = pwd.getpwuid(uid).pw_name
            except KeyError:
                users[uid] = str(uid)
        seen.add((name, users[uid]))
    return seen


def parse_unit_show(text: str) -> list[dict[str, str]]:
    units, cur = [], {}
    for line in [*text.splitlines(), ""]:
        if not line:
            if cur.get("Id"):
                units.append(cur)
            cur = {}
            continue
        key, _, value = line.partition("=")
        cur[key] = value
    return units


def _stamp(value: str) -> str | None:
    ok = value.startswith("@") and value[1:].replace(".", "").isdigit() and value != "@0"
    return _iso(float(value[1:])) if ok else None


def snapshot_units(
    db: sqlite3.Connection,
    manager: str,
    prefix: list[str],
    now_iso: str,
    run: core.Runner = core.run_command,
) -> int:
    listing = run(
        [*prefix, "list-units", "--all", "--plain", "--no-legend", "--full"], timeout=60
    ).out
    names = [
        ln.split()[0]
        for ln in listing.splitlines()
        if ln.split() and ln.split()[0].endswith(UNIT_TYPES)
    ]
    n = 0
    props = "Id,ActiveState,ActiveEnterTimestamp,InactiveEnterTimestamp"
    for i in range(0, len(names), 200):
        res = run(
            [*prefix, "show", "--timestamp=unix", "-p", props, *names[i : i + 200]], timeout=60
        )
        for u in parse_unit_show(res.out):
            db.execute(
                """INSERT INTO unit_seen(manager,unit,first_snapshot,last_snapshot,active_state,last_active_enter,
                     last_inactive_enter) VALUES(?,?,?,?,?,?,?)
                   ON CONFLICT(manager,unit) DO UPDATE SET last_snapshot=excluded.last_snapshot,
                     active_state=excluded.active_state,
                     last_active_enter=coalesce(max(last_active_enter, excluded.last_active_enter),
                       last_active_enter, excluded.last_active_enter),
                     last_inactive_enter=coalesce(max(last_inactive_enter, excluded.last_inactive_enter),
                       last_inactive_enter, excluded.last_inactive_enter)""",
                (
                    manager, u["Id"], now_iso, now_iso, u.get("ActiveState"),
                    _stamp(u.get("ActiveEnterTimestamp", "")), _stamp(u.get("InactiveEnterTimestamp", "")),
                ),
            )  # fmt: skip
            n += 1
    return n


def record_proc_sample(db_path: Path, now: datetime) -> int:
    db = connect(db_path)
    try:
        with db:
            iso = now.isoformat(timespec="seconds")
            n = upsert_execs(db, "proc", ((name, user, iso) for name, user in sample_proc()))
            db.execute("INSERT INTO runs VALUES(?,?,?)", (iso, "proc", n))
    finally:
        db.close()
    return n


def user_prefix(uid: int) -> list[str]:
    return ["systemctl", "--user"] if os.geteuid() == uid else user_systemctl(uid)


def collect(
    cfg: dict[str, Any],
    owner: str,
    db_path: Path,
    now: datetime,
    run: core.Runner = core.run_command,
) -> dict[str, Any]:
    """The full nightly collection. Returns {"counts": {source: rows}, "acct_ok": bool}."""
    iso = now.isoformat(timespec="seconds")
    counts: dict[str, int] = {}
    db = connect(db_path)
    acct_ok = False
    try:
        with db:
            counts["units_system"] = snapshot_units(db, "system", ["systemctl"], iso, run)
            for user in cfg.get("user_managers") or [owner]:
                try:
                    uid = pwd.getpwnam(user).pw_uid
                except KeyError:
                    continue
                counts[f"units_user_{user}"] = snapshot_units(
                    db, f"user:{user}", user_prefix(uid), iso, run
                )
            counts["proc"] = upsert_execs(
                db, "proc", ((name, user, iso) for name, user in sample_proc())
            )
            acct_rows = 0
            for pacct in cfg["pacct_files"]:
                if Path(pacct).exists():
                    rc, parsed = stream_lastcomm(pacct, now, float(cfg["lastcomm_timeout"]))
                    acct_ok = acct_ok or rc == 0
                    acct_rows += upsert_execs(
                        db, "acct", ((c, u, t) for (c, u), t in parsed.items())
                    )
            counts["acct"] = acct_rows
            for kind, n in counts.items():
                db.execute("INSERT INTO runs VALUES(?,?,?)", (iso, kind, n))
    finally:
        db.close()
    return {"counts": counts, "acct_ok": acct_ok}


def last_collected(db_path: Path) -> float | None:
    """When the last full collection ran (the units_system run row), or None."""
    try:
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        row = db.execute("SELECT max(ts) FROM runs WHERE kind='units_system'").fetchone()
    except sqlite3.Error:
        return None
    finally:
        db.close()
    if not row or not row[0]:
        return None
    try:
        return datetime.fromisoformat(row[0]).timestamp()
    except ValueError:
        return None
