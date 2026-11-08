"""Standing performance duty on the workstation: units stuck in a restart loop, swap in use while RAM is free.

Port of the two perf probes that carry a state: ns/checks/perf.py crash loops and swap-while-free. The
info-only probes (timer CPU, idle stacks, exited containers, drop-ins, journal volume, GitNexus fan-out,
memory.high events) were records nobody acted on and are not ported.
"""

from __future__ import annotations

import json
import re
from typing import Any

from host_steward.core import Ctx, Signal

ID = "perf"
RESTART = re.compile(r"^(\S+?): Scheduled restart job, restart counter is at (\d+)")


def restart_counts(json_lines: str, owner_uid: int) -> dict[tuple[str, str], int]:
    """(manager, unit) -> restarts in the window, from `journalctl -o json` 'Scheduled restart job' entries."""
    out: dict[tuple[str, str], int] = {}
    for line in json_lines.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("MESSAGE") if isinstance(entry, dict) else None
        match = RESTART.match(message) if isinstance(message, str) else None
        if not match:
            continue
        manager = "user" if str(entry.get("_SYSTEMD_UNIT", "")) == f"user@{owner_uid}.service" else "system"
        key = (manager, match.group(1))
        out[key] = out.get(key, 0) + 1
    return out


def meminfo_kb(text: str) -> dict[str, int]:
    out = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        if rest.split()[:1] and rest.split()[0].isdigit():
            out[key] = int(rest.split()[0])
    return out


def crash_loops(ctx: Ctx) -> Signal:
    cfg: dict[str, Any] = ctx.cfg
    result = ctx.run(
        ["journalctl", "--since", "-1h", "--no-pager", "-o", "json", "-g", "Scheduled restart job"], timeout=60
    )
    if result.rc not in (0, 1):  # grep-style: 1 is "no match"
        return Signal("perf.crash_loop.unreadable", "warn", {"why": result.err.strip()[:60]})
    counts = restart_counts(result.out, int(cfg["owner_uid"]))
    loops = sorted(((n, key) for key, n in counts.items() if n >= cfg["crash_restarts_per_hour"]), reverse=True)
    if not loops:
        return Signal("perf.crash_loop", "ok")
    names = ", ".join(f"{unit} ({n}/h)" for n, (_, unit) in loops[:3])
    return Signal("perf.crash_loop", "warn", {"n": len(loops), "units": names})


def psi_some_avg10(ctx: Ctx) -> float | None:
    """Memory pressure (the `some` avg10 percent), or None when it cannot be read."""
    match = re.search(r"^some .*?avg10=([\d.]+)", ctx.read(ctx.cfg["psi"]) or "", re.MULTILINE)
    return float(match.group(1)) if match else None


def clear_stale_swap(ctx: Ctx, used_gib: float, avail_gib: float) -> bool:
    """Gives parked pages back to RAM (swapoff, then swapon) when that is safe: switched on in [acting], memory
    available beyond what swap holds by the headroom, and no memory stalls right now. Swap that is full of old pages
    while RAM is free is nothing an owner or agent should chase, so the check clears it instead of warning."""
    psi = psi_some_avg10(ctx)
    if (
        not ctx.acting.get("swap_clear")
        or avail_gib < used_gib + float(ctx.cfg["swap_clear_headroom_gib"])
        or psi is None
        or psi >= float(ctx.cfg["swap_clear_max_psi"])
    ):
        return False
    off = ctx.run(["swapoff", "-a"], timeout=float(ctx.cfg["swap_clear_timeout_s"]))
    # Always bring swap back, even when swapoff stopped part way.
    on = ctx.run(["swapon", "-a"], timeout=60)
    return off.rc == 0 and on.rc == 0


def swap_while_free(ctx: Ctx) -> Signal:
    text = ctx.read(ctx.cfg["meminfo"])
    if text is None:
        return Signal("perf.swap.unreadable", "warn")
    info = meminfo_kb(text)
    total, free = info.get("SwapTotal", 0), info.get("SwapFree", 0)
    if not total:
        return Signal("perf.swap", "ok", {"pct": "0", "avail": f"{info.get('MemAvailable', 0) / 1048576:.0f}"})
    pct = (total - free) * 100 / total
    avail = info.get("MemAvailable", 0) / 1048576
    fields = {"pct": f"{pct:.0f}", "avail": f"{avail:.0f}"}
    if pct >= ctx.cfg["swap_used_pct"] and avail >= ctx.cfg["swap_mem_available_gib"]:
        used_gib = (total - free) / 1048576
        if clear_stale_swap(ctx, used_gib, avail):
            return Signal("perf.swap.cleared", "ok", {"pct": fields["pct"], "gib": f"{used_gib:.0f}"}, note=True)
        return Signal("perf.swap", "warn", fields)
    return Signal("perf.swap", "ok", fields)


def run(ctx: Ctx) -> list[Signal]:
    return [crash_loops(ctx), swap_while_free(ctx)]
