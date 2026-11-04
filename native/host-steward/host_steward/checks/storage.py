"""Workstation storage: free space per disk against its lines, Btrfs allocation headroom and device errors, SMART.

Port of ns/checks/storage.py. An internal disk is rated against the free-space reserve where SummitFlow starts
refusing backups: the data file's reserve_gib (Nightshift also read SummitFlow's own setting from ~/.env.local; that
file holds credentials and is not opened here). Each run also keeps the disk's free space in a 48 hour sample ring
(this check's state) for the fill rate: the hours until the reserve at the 6 hour and 24 hour pace, with the pace
capped at the last hour's (a one-off step is not a trend). The space guard's ballast counts as free for the
projection and its last reclaim run is a signal; the guard's state file is read from the first of the data file's
guard_state paths that is newest. Readings go to the trend history (history.py): disk percent used and the SMART
counters per serial number.
"""

from __future__ import annotations

import re
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from host_steward import acts, history
from host_steward.core import Ctx, Signal
from host_steward.trend import slope

ID = "storage"
GIB = 1024**3
SMART_COUNTERS = (  # name, pattern on smartctl -A text (NVMe log lines, ATA attribute raw values)
    ("media_errors", re.compile(r"^Media and Data Integrity Errors:\s+([\d,]+)", re.MULTILINE)),
    ("percentage_used", re.compile(r"^Percentage Used:\s+(\d+)%", re.MULTILINE)),
    ("reallocated", re.compile(r"^\s*5 Reallocated_Sector_Ct\s.*?(\d+)\s*$", re.MULTILINE)),
    ("pending", re.compile(r"^\s*197 Current_Pending_Sector\s.*?(\d+)\s*$", re.MULTILINE)),
)
SMART_METRICS = {
    "media_errors": ("disk.media_errors", "counter"),
    "reallocated": ("disk.realloc", "counter"),
    "pending": ("disk.pending", "counter"),
    "percentage_used": ("disk.wear_pct", "gauge"),
}
SMART_FAILED = re.compile(
    r"SMART overall-health.*FAILED|SMART Health Status:\s*BAD|Critical Warning:\s*0x0*[1-9a-f]",
    re.IGNORECASE,
)
SELFTEST_FAILED = re.compile(r"^\s*(?:#\s*1|0)\s.*fail", re.IGNORECASE | re.MULTILINE)


def reserve_state(free_gib: float, cfg: dict[str, Any]) -> str:
    reserve = float(cfg["reserve_gib"])
    if free_gib < reserve + float(cfg["capture_peak_gib"]) or free_gib <= float(
        cfg["critical_floor_gib"]
    ):
        return "failed"
    return "warn" if free_gib < reserve + float(cfg["warn_margin_gib"]) else "ok"


def plain_state(pct: float, free_gib: float, cfg: dict[str, Any]) -> str:
    """A disk with no reserve (a backup drive): tight percent with little headroom, or little headroom at all."""
    if (
        (pct >= cfg["disk_crit_tight_pct"] and free_gib <= cfg["disk_crit_tight_free_gib"])
        or pct >= cfg["disk_crit_pct"]
        or free_gib <= cfg["disk_crit_free_gib"]
    ):
        return "failed"
    if (
        pct >= cfg["disk_warn_tight_pct"] and free_gib <= cfg["disk_warn_tight_free_gib"]
    ) or free_gib <= cfg["disk_warn_free_gib"]:
        return "warn"
    return "ok"


def fill_rate(samples: list[list[float]], now: float, window_s: float) -> float | None:
    """GiB per hour the free space falls over the window (least squares; positive while filling). None until three
    samples span 45 minutes."""
    pts = [(ts, b) for ts, b in samples if now - window_s <= ts <= now + 60]
    if len(pts) < 3 or pts[-1][0] - pts[0][0] < 2700:
        return None
    return -slope([((ts - now) / 3600, b / GIB) for ts, b in pts])


def hours_to(free_gib: float, reserve: float, rate: float | None) -> float | None:
    if rate is None or rate < 0.01:
        return None
    return round(max(free_gib - reserve, 0.0) / rate, 1)


def fill_state(short_h: float | None, long_h: float | None, crit_h: float, warn_h: float) -> str:
    if short_h is not None and short_h <= crit_h:
        return "failed"
    return "warn" if any(h is not None and h <= warn_h for h in (short_h, long_h)) else "ok"


def add_sample(
    state: dict[str, Any], key: str, free_bytes: int, now: float, keep_s: float
) -> list[list[float]]:
    """This run's free bytes onto the disk's ring in the check's state (older than keep_s dropped)."""
    ring = state.setdefault("samples", {})
    rows = [
        r
        for r in ring.get(key, [])
        if isinstance(r, list) and len(r) == 2 and now - keep_s <= r[0] < now
    ]
    rows.append([round(now, 1), int(free_bytes)])
    ring[key] = rows
    return rows


def newest_state(paths: list[str]) -> dict[str, Any]:
    """The space guard's state: the candidate file with the newest `at` (its own file once it has run, else the one it
    inherited from Nightshift)."""
    best, best_at = {}, -1.0
    for raw in paths:
        data = acts.read_json(Path(raw))
        try:
            at = datetime.fromisoformat(str(data.get("at", ""))).timestamp()
        except ValueError:
            at = 0.0
        if data and at > best_at:
            best, best_at = data, at
    return best


def guard_paths(cfg: dict[str, Any], name: str, inherit: str) -> list[str]:
    return [str(acts.job_dir() / name), *[str(x) for x in cfg.get(inherit, [])]]


def snapshot_points(mount: str) -> int:
    """SummitFlow work snapshots (whole-subvolume points) under the disk's managed store; they pin deleted data."""
    try:
        return sum(1 for _ in Path(mount, ".snapshots").glob("*/projects/*/*"))
    except OSError:
        return 0


def space_note(path: str, growers: dict[str, Any], snapshots: int) -> str:
    """What holds the space on one disk: snapshot points, the fastest growers and the largest directories."""
    fs = (growers.get("filesystems") or {}).get(path) or {}
    entries = [e for e in fs.get("top", []) if isinstance(e, dict) and e.get("path")]
    grew = sorted((e for e in entries if (e.get("grew") or 0) >= GIB), key=lambda e: -e["grew"])[:3]
    big = [e for e in sorted(entries, key=lambda e: -e.get("bytes", 0)) if e not in grew][:3]
    parts = [f"{snapshots} workspace snapshots pin deleted data"] if snapshots else []
    if grew:
        since = (
            time.strftime("%a %H:%M", time.localtime(fs["prev_at"]))
            if fs.get("prev_at")
            else "the last measurement"
        )
        parts.append(
            f"grew since {since}: "
            + ", ".join(f"{e['path']} +{e['grew'] / GIB:.1f} GiB" for e in grew)
        )
    if big:
        parts.append(
            "largest: " + ", ".join(f"{e['path']} {e['bytes'] / GIB:.1f} GiB" for e in big)
        )
    if not parts:
        return ""
    at = fs.get("at")
    return "; ".join(parts) + (
        f" (measured {time.strftime('%H:%M', time.localtime(at))})" if at and entries else ""
    )


def reclaim_signal(
    entry: dict[str, Any],
    guard: dict[str, Any],
    reserve: float,
    note: str,
    now: float,
    fresh_s: float,
) -> Signal:
    """The space guard's last reclaim on this disk: failed when every tier ran and free space is still under the
    reserve (what it could do is used up)."""
    try:
        at = datetime.fromisoformat(str(guard.get("at", ""))).timestamp()
    except ValueError:
        at = 0.0
    rep = next(
        (
            r
            for r in guard.get("filesystems", [])
            if isinstance(r, dict) and r.get("path") == entry["path"]
        ),
        {},
    )
    lad = rep.get("ladder") or {}
    name = entry["name"]
    if not lad or now - at > fresh_s:
        return Signal("storage.reclaim.idle", "ok", {"name": name})
    tiers = ", ".join(lad.get("tiers") or []) or "none"
    if lad.get("exhausted"):
        return Signal(
            "storage.reclaim.exhausted",
            "failed",
            {
                "name": name,
                "tiers": tiers,
                "free": lad.get("free_after_gib"),
                "reserve": f"{reserve:g}",
                "held": note,
            },
        )
    if lad.get("tiers"):
        return Signal(
            "storage.reclaim.ran",
            "ok",
            {
                "name": name,
                "tiers": tiers,
                "before": lad.get("free_before_gib"),
                "after": lad.get("free_after_gib"),
            },
            note=True,
        )
    return Signal("storage.reclaim.idle", "ok", {"name": name})


def parse_btrfs_usage(text: str) -> dict[str, int]:
    keys = {
        "Device size": "size",
        "Device unallocated": "unallocated",
        "Device missing": "missing",
        "Free (estimated)": "free",
    }
    out: dict[str, int] = {}
    for line in text.splitlines():
        name, _, rest = line.strip().partition(":")
        if name in keys and (m := re.match(r"\s*(\d+)", rest)):
            out[keys[name]] = int(m.group(1))
    return out


def parse_device_stats(text: str) -> dict[str, int]:
    stats: dict[str, int] = {}
    for line in text.splitlines():
        if m := re.search(r"\.([a-z_]+)\s+(\d+)$", line.strip()):
            stats[m.group(1)] = stats.get(m.group(1), 0) + int(m.group(2))
    return stats


def parse_scan(text: str) -> list[tuple[str, str]]:
    """`smartctl --scan-open` -> (device, -d type); the type matters for USB bridges."""
    out = []
    for line in text.split("\n"):
        parts = line.split("#", 1)[0].split()
        if parts and parts[0].startswith("/dev/"):
            out.append((parts[0], parts[2] if len(parts) >= 3 and parts[1] == "-d" else ""))
    return out


def fill(ctx: Ctx, entry: dict[str, Any], free_bytes: int, free: float, level: str) -> list[Signal]:
    """The fill rate, the ballast and the space guard's last reclaim for a disk rated against the reserve."""
    cfg, now = ctx.cfg, ctx.now
    name, path = entry["name"], entry["path"]
    reserve = float(cfg["reserve_gib"])
    if (
        "samples" not in ctx.state
    ):  # the first run starts from Nightshift's ring so the rate is known at once
        ctx.state["samples"] = {
            k: v
            for k, v in acts.read_json(Path(str(cfg["samples_inherit"]))).items()
            if isinstance(v, list)
        }
    samples = add_sample(ctx.state, path, free_bytes, now, 3600 * float(cfg["sample_keep_hours"]))
    guard = newest_state(guard_paths(cfg, "space-guard.json", "guard_inherit"))
    ballast = int((guard.get("ballast") or {}).get(path) or 0)
    recent_s = 3600 * float(cfg["fill_recent_hours"])
    short = fill_rate(samples, now, 3600 * float(cfg["fill_short_hours"]))
    long = fill_rate(samples, now, 3600 * float(cfg["fill_long_hours"]))
    recent = fill_rate(samples, now, recent_s)
    if (
        recent is not None
    ):  # a window's fall that the last hour no longer shows was a step, not a trend
        short, long = (None if r is None else min(r, recent) for r in (short, long))
    eff = free + ballast / GIB  # the ballast is released before the reserve is reached
    hs, hl = hours_to(eff, reserve, short), hours_to(eff, reserve, long)
    out: list[Signal] = []
    growers = newest_state(guard_paths(cfg, "growers.json", "growers_inherit"))
    sev = fill_state(hs, hl, float(cfg["fill_critical_hours"]), float(cfg["fill_warning_hours"]))
    held = space_note(path, growers, snapshot_points(path)) if "ok" != level or sev != "ok" else ""
    held = f"; {held}" if held else ""
    rate, hours = (short, hs) if hs is not None and (hl is None or hs <= hl) else (long, hl)
    if sev != "ok" and hours is not None and rate is not None:
        out.append(
            Signal(
                "storage.fill",
                sev,
                {"name": name, "rate": f"{rate:.1f}", "hours": f"{hours:g}", "held": held},
            )
        )
    if ballast:
        out.append(
            Signal(
                "storage.ballast", "ok", {"name": name, "gib": f"{ballast / GIB:.0f}"}, note=True
            )
        )
    out.append(reclaim_signal(entry, guard, reserve, held, now, float(cfg["guard_fresh_s"])))
    return out


def disk(ctx: Ctx, entry: dict[str, Any]) -> list[Signal]:
    cfg = ctx.cfg
    name, path = entry["name"], entry["path"]
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        state = entry.get("missing", "failed")
        return [Signal("storage.disk.missing", state, {"name": name})]
    free = usage.free / GIB
    pct = round(usage.used * 100 / (usage.used + usage.free), 1) if usage.used + usage.free else 0.0
    state = reserve_state(free, cfg) if entry.get("balance") else plain_state(pct, free, cfg)
    history.record(ctx.cache, "disk.used_pct", "workstation", pct, path)
    out = [
        Signal(
            "storage.disk.space", state, {"name": name, "free": f"{free:.0f}", "pct": f"{pct:.0f}"}
        )
    ]
    if entry.get("balance"):
        out += fill(ctx, entry, usage.free, free, state)
    if not entry.get("btrfs"):
        return out
    if not shutil.which("btrfs"):
        return [*out, Signal("storage.btrfs.missing", "warn", {"name": name})]
    result = ctx.run(["btrfs", "filesystem", "usage", "-b", path], timeout=60)
    usage_map = parse_btrfs_usage(result.out)
    if result.rc != 0 or not {"unallocated", "missing", "free"} <= usage_map.keys():
        out.append(Signal("storage.alloc.unreadable", "warn", {"name": name}))
    else:
        free_gib, unalloc = usage_map["free"] / GIB, usage_map["unallocated"] / GIB
        if usage_map["missing"] or unalloc < cfg["alloc_trigger_gib"]:
            alloc = "failed"
        elif unalloc < cfg["alloc_target_gib"] or free_gib < cfg["alloc_free_warn_gib"]:
            alloc = "warn"
        else:
            alloc = "ok"
        out.append(Signal("storage.alloc", alloc, {"name": name, "unallocated": f"{unalloc:.0f}"}))
    stats = ctx.run(["btrfs", "device", "stats", path], timeout=30)
    bad = {k: v for k, v in parse_device_stats(stats.out).items() if v}
    if stats.rc != 0 or bad:
        out.append(
            Signal(
                "storage.btrfs.errors",
                "failed",
                {
                    "name": name,
                    "errors": ", ".join(f"{k} {v}" for k, v in bad.items()) or "unreadable",
                },
            )
        )
    else:
        out.append(Signal("storage.btrfs.errors", "ok", {"name": name}))
    return out


def smart_counters(text: str) -> dict[str, Any]:
    """Health counters and the serial for the trend history; absent ones are left out."""
    out: dict[str, Any] = {
        k: int(m.group(1).replace(",", "")) for k, rx in SMART_COUNTERS if (m := rx.search(text))
    }
    if m := re.search(r"^Serial Number:\s+(\S+)", text, re.MULTILINE):
        out["serial"] = m.group(1)
    return out


def smart(ctx: Ctx) -> list[Signal]:
    if not shutil.which("smartctl"):
        return [Signal("storage.smart.missing", "warn")]
    out = []
    for dev, kind in parse_scan(ctx.run(["smartctl", "--scan-open"], timeout=30).out):
        result = ctx.run(
            ["smartctl", "-i", "-H", "-A", "-l", "selftest", *(["-d", kind] if kind else []), dev],
            timeout=60,
        )
        text = f"{result.out}\n{result.err}"
        counters = smart_counters(text)
        for key, (metric, kind) in SMART_METRICS.items():
            if key in counters:
                history.record(
                    ctx.cache,
                    metric,
                    "workstation",
                    float(counters[key]),
                    str(counters.get("serial") or dev),
                    agg="max",
                    kind=kind,
                )
        if SMART_FAILED.search(text):
            out.append(
                Signal("storage.smart", "failed", {"dev": dev, "why": "health check failed"})
            )
        elif SELFTEST_FAILED.search(text):
            out.append(
                Signal("storage.smart", "failed", {"dev": dev, "why": "latest self-test failed"})
            )
        else:
            out.append(Signal("storage.smart", "ok", {"dev": dev}))
    return out


def run(ctx: Ctx) -> list[Signal]:
    out: list[Signal] = []
    for entry in ctx.cfg["disks"]:
        out += disk(ctx, entry)
    return out + smart(ctx)
