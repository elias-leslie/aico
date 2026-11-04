"""Usage evidence: take the cheap process sample on every pass and watch that the nightly collection ran.

Port of ns/checks/usage.py. The full collection (units, process accounting) is the `collect-usage` job; this check
records the /proc sample Nightshift took on every check pass and warns when the last full collection is older than
stale_hours (or none has happened since this check started watching).
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from host_steward import usage
from host_steward.core import Ctx, Signal

ID = "usage"


def run(ctx: Ctx) -> list[Signal]:
    db = Path(ctx.cfg["db"])
    try:
        samples = usage.record_proc_sample(db, datetime.fromtimestamp(ctx.now, UTC))
    except OSError as error:
        return [Signal("usage.sample_failed", "warn", {"why": str(error)[:60]})]
    last = usage.last_collected(db)
    watch = float(ctx.state.setdefault("watch_since", ctx.now))
    since = max(last or 0.0, watch)
    age_h = (ctx.now - since) / 3600
    if age_h > float(ctx.cfg["stale_hours"]):
        how = (
            f"{age_h:.0f} hours ago"
            if last
            else f"in the {age_h:.0f} hours since this check started"
        )
        return [Signal("usage.collect_stale", "warn", {"how": how, "samples": samples})]
    return [Signal("usage.collect", "ok", {"samples": samples})]
