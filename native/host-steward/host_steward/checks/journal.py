"""The system journal: files journalctl skips as corrupt, and new kinds of warning messages.

Port of ns/checks/journal.py. Corrupt files: journald removes one when it ages out, so it is a note; one still
there 35 days after it was first seen is past the retention and warns. First-seen times are kept in this check's
state. Signatures: the journal's warnings since the last run are clustered into message templates
(host_steward/journal_miner.py, a Drain-style miner with a cursor); a template first seen in the last 24 hours that
the known table does not label is "new", which Nightshift showed as an info line and so does this row (a note, never
a problem): failed units, memory kills and crashes have their own checks, and container output is not counted. The
clusters and the report (journal-signatures.json, the top signatures and the new ones) are files beside the state
file. The first run adopts Nightshift's journal state read-only (clusters, baseline, cursor), so what it already
knew is not new again. A run that reads a journal it cannot read, or a cursor journald no longer has, falls back to
the initial window.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from host_steward import core, journal_miner
from host_steward.core import Ctx, Signal

ID = "journal"
CORRUPT = re.compile(r"^Journal file (/\S+) [^\n]*ignoring file", re.MULTILINE)


def corrupt(ctx: Ctx) -> Signal:
    result = ctx.run(["journalctl", "--no-pager", "-q", "-n", "1", "-o", "cat"], timeout=60)
    if result.rc != 0:
        return Signal(
            "journal.unreadable", "warn", {"why": (result.err or "no answer").strip()[:60]}
        )
    previous = ctx.state.get("seen", {})
    seen = {name: float(previous.get(name, ctx.now)) for name in CORRUPT.findall(result.err)}
    ctx.state["seen"] = seen
    keep = float(ctx.cfg["corrupt_keep_days"]) * 86400
    old = [name for name, at in seen.items() if ctx.now - at >= keep]
    if old:
        return Signal(
            "journal.corrupt",
            "warn",
            {"n": len(seen), "old": len(old), "days": ctx.cfg["corrupt_keep_days"]},
        )
    if seen:
        return Signal("journal.corrupt", "ok", {"n": len(seen)}, note=True)
    return Signal("journal.corrupt", "ok", {"n": 0})


def _path(ctx: Ctx, key: str) -> Path:
    return core.STATE_PATH.parent / ctx.cfg[key]


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_private(path: Path, data: Any) -> None:
    """Journal-derived files hold raw message examples: readable by root and adm (like the journal)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, sort_keys=True))
    if os.geteuid() == 0:
        with contextlib.suppress(KeyError, OSError):
            import grp

            os.chown(tmp, 0, grp.getgrnam("adm").gr_gid)
        os.chmod(tmp, 0o640)
    tmp.replace(path)


def read_journal(ctx: Ctx, cursor: str | None) -> tuple[list[str], str | None] | None:
    """(json lines, the cursor used) for the warnings since the cursor; None when journalctl failed. A cursor
    journald does not have any more is dropped for the initial window."""
    cfg = ctx.cfg
    base = [
        "journalctl",
        "-p",
        "warning",
        "-o",
        "json",
        "--no-pager",
        "-n",
        str(int(cfg["max_entries"])),
    ]
    if cursor:
        result = ctx.run([*base, "--after-cursor", cursor], timeout=180)
        if result.rc == 0:
            return result.out.splitlines(), cursor
    result = ctx.run([*base, "--since", str(cfg["initial_since"])], timeout=180)
    return (result.out.splitlines(), None) if result.rc == 0 else None


def signatures(ctx: Ctx) -> Signal:
    cfg = ctx.cfg
    state_path, report_path = _path(ctx, "cluster_file"), _path(ctx, "signatures_file")
    now = datetime.fromtimestamp(ctx.now, UTC)
    saved = _read_json(state_path)
    adopted = False
    if saved is None and cfg.get("adopt_from"):
        saved, adopted = _read_json(Path(cfg["adopt_from"])), True
    cursor, clusters, baseline_at = journal_miner.load_clusters(saved or {})
    baseline_at = baseline_at or now.isoformat()
    miner = journal_miner.Miner(
        clusters, float(cfg["similarity"]), int(cfg["max_clusters_per_group"])
    )
    read = read_journal(ctx, cursor)
    if read is None:
        return Signal("journal.signatures.unreadable", "warn")
    lines, used = read
    n, new_cursor = journal_miner.ingest(miner, lines)
    per_ident = max(1, int(cfg["max_clusters_per_ident"]))
    try:
        _write_private(
            state_path,
            journal_miner.state_dict(
                new_cursor or used,
                miner.clusters(),
                now,
                baseline_at,
                int(cfg["retain_days"]),
                per_ident,
            ),
        )
        known = journal_miner.compile_known(cfg["known"])
        rep = journal_miner.report(miner, now, int(cfg["top_n"]), known, baseline_at)
        rep["ingested_this_run"] = n
        rep["adopted_from_nightshift"] = adopted
        _write_private(report_path, rep)
    except OSError as error:
        return Signal("journal.signatures.unwritable", "warn", {"why": str(error)[:60]})
    new = rep["new_unlabeled"]
    fields = {"new": len(new), "tracked": rep["clusters_total"], "ingested": n}
    return Signal("journal.signatures", "ok", fields, note=bool(new))


def run(ctx: Ctx) -> list[Signal]:
    return [corrupt(ctx), signatures(ctx)]
