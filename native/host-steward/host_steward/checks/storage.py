"""Workstation storage: free space per disk against its lines, Btrfs allocation headroom and device errors, SMART.

Port of ns/checks/storage.py without the fill-rate projection, the space guard's reclaim tiers and the
largest-directories notes (the space guard is housekeeping, M5a-2). An internal disk is rated against the
free-space reserve where SummitFlow starts refusing backups: the data file's reserve_gib (Nightshift also read
SummitFlow's own setting from ~/.env.local; that file holds credentials and is not opened here).
"""

from __future__ import annotations

import re
import shutil
from typing import Any

from host_steward.core import Ctx, Signal

ID = "storage"
GIB = 1024**3
SMART_FAILED = re.compile(r"SMART overall-health.*FAILED|SMART Health Status:\s*BAD|Critical Warning:\s*0x0*[1-9a-f]", re.IGNORECASE)
SELFTEST_FAILED = re.compile(r"^\s*(?:#\s*1|0)\s.*fail", re.IGNORECASE | re.MULTILINE)


def reserve_state(free_gib: float, cfg: dict[str, Any]) -> str:
    reserve = float(cfg["reserve_gib"])
    if free_gib < reserve + float(cfg["capture_peak_gib"]) or free_gib <= float(cfg["critical_floor_gib"]):
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
    if (pct >= cfg["disk_warn_tight_pct"] and free_gib <= cfg["disk_warn_tight_free_gib"]) or free_gib <= cfg[
        "disk_warn_free_gib"
    ]:
        return "warn"
    return "ok"


def parse_btrfs_usage(text: str) -> dict[str, int]:
    keys = {"Device size": "size", "Device unallocated": "unallocated", "Device missing": "missing", "Free (estimated)": "free"}
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
    out = [Signal("storage.disk.space", state, {"name": name, "free": f"{free:.0f}", "pct": f"{pct:.0f}"})]
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
        out.append(Signal("storage.btrfs.errors", "failed", {"name": name, "errors": ", ".join(f"{k} {v}" for k, v in bad.items()) or "unreadable"}))
    else:
        out.append(Signal("storage.btrfs.errors", "ok", {"name": name}))
    return out


def smart(ctx: Ctx) -> list[Signal]:
    if not shutil.which("smartctl"):
        return [Signal("storage.smart.missing", "warn")]
    out = []
    for dev, kind in parse_scan(ctx.run(["smartctl", "--scan-open"], timeout=30).out):
        result = ctx.run(["smartctl", "-i", "-H", "-A", "-l", "selftest", *(["-d", kind] if kind else []), dev], timeout=60)
        text = f"{result.out}\n{result.err}"
        if SMART_FAILED.search(text):
            out.append(Signal("storage.smart", "failed", {"dev": dev, "why": "health check failed"}))
        elif SELFTEST_FAILED.search(text):
            out.append(Signal("storage.smart", "failed", {"dev": dev, "why": "latest self-test failed"}))
        else:
            out.append(Signal("storage.smart", "ok", {"dev": dev}))
    return out


def run(ctx: Ctx) -> list[Signal]:
    out: list[Signal] = []
    for entry in ctx.cfg["disks"]:
        out += disk(ctx, entry)
    return out + smart(ctx)
