"""The system journal: files journalctl skips as corrupt.

Port of the corrupt-files part of ns/checks/journal.py. journald removes a corrupt file when it ages out, so it is
a note; one still there 35 days after it was first seen is past the retention and warns. The signature miner
(new unlabelled journal messages) fed Nightshift's nightly triage and is not ported. First-seen times are kept in
this check's state.
"""

from __future__ import annotations

import re

from host_steward.core import Ctx, Signal

ID = "journal"
CORRUPT = re.compile(r"^Journal file (/\S+) [^\n]*ignoring file", re.MULTILINE)


def run(ctx: Ctx) -> list[Signal]:
    result = ctx.run(["journalctl", "--no-pager", "-q", "-n", "1", "-o", "cat"], timeout=60)
    if result.rc != 0:
        return [Signal("journal.unreadable", "warn", {"why": (result.err or "no answer").strip()[:60]})]
    previous = ctx.state.get("seen", {})
    seen = {name: float(previous.get(name, ctx.now)) for name in CORRUPT.findall(result.err)}
    ctx.state["seen"] = seen
    keep = float(ctx.cfg["corrupt_keep_days"]) * 86400
    old = [name for name, at in seen.items() if ctx.now - at >= keep]
    if old:
        return [Signal("journal.corrupt", "warn", {"n": len(seen), "old": len(old), "days": ctx.cfg["corrupt_keep_days"]})]
    if seen:
        return [Signal("journal.corrupt", "ok", {"n": len(seen)}, note=True)]
    return [Signal("journal.corrupt", "ok", {"n": 0})]
