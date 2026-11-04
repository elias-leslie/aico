"""PVE memory errors: uncorrected events, corrected-event spikes and new regions, from the kernel journal and rasdaemon.

Port of ns/checks/ecc.py and the ECC rules in ns/checks/pve.py. Each run also puts the days of the journal window
into the trend history (corrected events, events with the overflow flag, uncorrected events per day; the trends
check evaluates the multi-week rules). The window is the 8 days the PVE snippet reads. A region with
corrected errors is new when this check's saved state has not seen it: the first run adopts every region it finds. Memory-controller
records only: one machine check is logged by up to four banks within the same second, so records are grouped into
events first. The data file caps corrected-error signals (this PVE host reports them without DRAM ECC: record
only); uncorrected errors and a new region still fail.
"""

from __future__ import annotations

import re
import statistics
from datetime import datetime
from typing import Any

from host_steward import history
from host_steward.checks.pve import collect
from host_steward.core import Ctx, Signal

ID = "ecc"
RAS_LINE = re.compile(r"^\d+ (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}) error: ([^,]*),")
DAY = 86400


def _hex(text: str | None) -> int | None:
    if not text or text == "-":
        return None
    try:
        return int(text, 16) or None
    except ValueError:
        return None


def parse_journal(text: str) -> tuple[float | None, list[dict[str, Any]]]:
    first: float | None = None
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        p = line.split()
        if len(p) < 2:
            continue
        try:
            ts = float(p[1])
        except ValueError:
            continue
        if p[0] == "FIRST":
            first = ts
        elif p[0] in ("CE", "UE"):
            out.append(
                {
                    "src": "j",
                    "ts": ts,
                    "kind": p[0],
                    "over": len(p) > 3 and p[3] == "1",
                    "addr": _hex(p[4]) if len(p) > 4 else None,
                    "umc": p[5] == "1" if len(p) > 5 else True,
                }
            )
    return first, out


def parse_rasdaemon(text: str) -> list[dict[str, Any]]:
    out = []
    for line in text.splitlines():
        m = RAS_LINE.match(line.strip())
        if not m:
            continue
        try:
            ts = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S %z").timestamp()
        except ValueError:
            continue
        kind = (
            "UE"
            if re.search(r"[Uu]ncorrected|[Dd]eferred|[Ff]atal", m.group(2))
            else "CE"
            if "orrected" in m.group(2)
            else ""
        )
        if kind:
            addr = re.search(r"\baddr=(0x[0-9a-fA-F]+)", line)
            out.append(
                {
                    "src": "r",
                    "ts": ts,
                    "kind": kind,
                    "addr": _hex(addr.group(1)) if addr else None,
                    "umc": "Unified Memory Controller" in line,
                }
            )
    return out


def group_events(
    records: list[dict[str, Any]], gap_s: float, region_shift: int
) -> list[dict[str, Any]]:
    """One event per machine check and source; its region is the 2 MiB region at least two banks agree on."""
    events: list[dict[str, Any]] = []
    open_event: dict[tuple[str, str], dict[str, Any]] = {}
    addrs: dict[int, list[int]] = {}
    for r in sorted(records, key=lambda e: (e["src"], e["kind"], e["ts"])):
        ev = open_event.get((r["src"], r["kind"]))
        if ev is None or r["ts"] - ev["ts"] > gap_s:
            ev = {"src": r["src"], "kind": r["kind"], "ts": r["ts"], "region": None, "over": False}
            open_event[(r["src"], r["kind"])] = ev
            events.append(ev)
        ev["over"] = ev["over"] or bool(r.get("over"))
        if r["addr"] is not None:
            addrs.setdefault(id(ev), []).append(r["addr"] >> region_shift)
    for ev in events:
        regions = addrs.get(id(ev))
        if regions:
            top = max(set(regions), key=lambda g: (regions.count(g), -g))
            ev["region"] = top if regions.count(top) >= 2 else None
    return events


def remember_regions(
    regions: set[int], state: dict[str, Any], now: float, hold_s: float
) -> list[int]:
    """Memory regions with corrected errors that this check had not seen before, still inside the hold window.
    The first run adopts every region in the journal window silently (the history Nightshift kept in its database)."""
    known = {int(r) for r in state.get("regions", [])}
    first = "regions" not in state
    new = state.setdefault("new", {})
    for region in sorted(regions - known):
        if not first:
            new[str(region)] = now
    state["regions"] = sorted(known | regions)
    state["new"] = {r: t for r, t in new.items() if now - float(t) <= hold_s}
    return sorted(int(r) for r in state["new"])


def daily_counts(events: list[dict[str, Any]], now: float) -> dict[str, dict[str, int]]:
    """Events per local day for the last 8 days: {day: {ce, ce_overflow, ue}} (the days the journal window covers)."""
    out: dict[str, dict[str, int]] = {}
    for e in events:
        if e["src"] != "j" or now - e["ts"] > 8 * DAY:
            continue
        day = history.day_of(e["ts"])
        row = out.setdefault(day, {"ce": 0, "ce_overflow": 0, "ue": 0})
        if e["kind"] == "UE":
            row["ue"] += 1
        else:
            row["ce"] += 1
            row["ce_overflow"] += bool(e.get("over"))
    return out


def record_history(
    cache: dict[str, Any], events: list[dict[str, Any]], first: float | None, now: float
) -> None:
    """Whole days of the journal window into the trend history: a count per day, zero for a quiet day the journal
    covers (so a quiet stretch counts as quiet, not as missing). Recording a day again replaces its count."""
    counts = daily_counts(events, now)
    for offset in range(8):  # the oldest day of the 8 day window is only partly covered
        ts = now - offset * DAY
        day = history.day_of(ts)
        if first is None or day <= history.day_of(first):
            continue
        row = counts.get(day, {"ce": 0, "ce_overflow": 0, "ue": 0})
        for metric, key in (("mem.ce", "ce"), ("mem.ce_overflow", "ce_overflow"), ("mem.ue", "ue")):
            history.record(cache, metric, "pve", float(row[key]), "", ts, "last", "events")


def evaluate(
    sections: dict[str, str],
    cfg: dict[str, Any],
    now: float,
    state: dict[str, Any],
    cache: dict[str, Any] | None = None,
) -> list[Signal]:
    first, journal = parse_journal(sections.get("ecc", ""))
    records = [r for r in journal + parse_rasdaemon(sections.get("rasmce", "")) if r["umc"]]
    events = group_events(records, float(cfg["event_gap_s"]), int(cfg["region_shift"]))
    if cache is not None:
        record_history(cache, events, first, now)

    def count(
        kind: str, lo: float, hi: float
    ) -> int:  # either source can miss records: the larger count
        return max(
            (
                sum(1 for e in events if e["src"] == s and e["kind"] == kind and lo < e["ts"] <= hi)
                for s in "jr"
            ),
            default=0,
        )

    out: list[Signal] = []
    uncorrected = count("UE", now - DAY, now)
    out.append(Signal("ecc.uncorrected", "failed" if uncorrected else "ok", {"n": uncorrected}))
    last = count("CE", now - DAY, now)
    windows = []
    for i in range(1, 8):
        start, end = now - (i + 1) * DAY, now - i * DAY
        if first is None or start < first:
            break
        windows.append(count("CE", start, end))
    baseline = statistics.median(windows) if windows else None
    spike = baseline is not None and last >= max(cfg["spike_min"], cfg["spike_factor"] * baseline)
    if spike:
        out.append(Signal("ecc.spike", "warn", {"n": last, "base": f"{baseline:g}"}, note=True))
    elif last:
        out.append(Signal("ecc.corrected", "warn", {"n": last}, note=True))
    else:
        out.append(Signal("ecc.corrected", "ok", {"n": 0}))
    regions = {e["region"] for e in events if e["kind"] == "CE" and e["region"] is not None}
    held = remember_regions(regions, state, now, float(cfg["hold_hours"]) * 3600)
    if held:
        out.append(Signal("ecc.new_region", "failed", {"n": len(held)}))
    return out


def run(ctx: Ctx) -> list[Signal]:
    sections, why = collect(ctx)
    if sections is None:
        return [Signal("pve.unreachable", "warn", {"why": why})]
    return evaluate(sections, ctx.cfg, ctx.now, ctx.state, ctx.cache)
