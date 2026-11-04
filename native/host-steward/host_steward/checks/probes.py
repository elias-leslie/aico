"""Two workstation probes: NVIDIA kernel modules and agent-driven local Chrome.

Port of ws.nvidia.kernel_module_missing and ws.browser.local_agent_chrome from ns/checks/workstation.py.
NVIDIA: every installed generic kernel needs an NVIDIA module for the installed driver branch (a package, or a
built nvidia.ko under /lib/modules); the newest or the running kernel without one means the next boot has no GPU
driver (failed), an old fallback kernel without one is a note. Browser: agent browsers belong on the browser VM;
local ones are a note, a warning only when large (RSS) or persistent (fallbacks from the VM to local Chrome in 24h).
Fallbacks while the VM was off on purpose are counted apart and never warn: the spans come from the guest task
history the PVE guests check saves in `guests_file` (beside the state file); without it every fallback counts.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from host_steward import core
from host_steward.core import Ctx, Signal

ID = "probes"
HISTORY_S = 172800  # the PVE pass reports guest start/stop tasks of the last two days
BRANCH = re.compile(r"nvidia-driver-(\d+(?:-open|-server(?:-open)?)?)")
KERNEL = re.compile(r"linux-image-\d[\w.+~-]*-generic")


def kver_key(kver: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", kver))


def nvidia_module_gaps(dpkg_out: str, running: str, has_module) -> tuple[str, list[dict[str, Any]]]:
    """(driver branch like '595-open', installed generic kernels lacking an NVIDIA module).
    dpkg_out: `${Package} ${db:Status-Abbrev}` lines; has_module(kver) says a built module exists."""
    inst = {
        ln.split()[0]
        for ln in dpkg_out.splitlines()
        if len(ln.split()) == 2 and ln.split()[1].startswith("ii")
    }
    branches = sorted(m.group(1) for n in inst if (m := BRANCH.fullmatch(n)))
    if not branches:
        return "", []
    branch = branches[-1]
    kernels = sorted((n[len("linux-image-") :] for n in inst if KERNEL.fullmatch(n)), key=kver_key)
    have = {n for n in inst if n.startswith("linux-modules-nvidia-")}
    gaps = []
    for kver in kernels:
        if any(n.endswith(f"-{kver}") for n in have) or has_module(kver):
            continue
        gaps.append(
            {
                "kernel": kver,
                "package": f"linux-modules-nvidia-{branch}-{kver}",
                "newest": kver == kernels[-1],
                "running": kver == running,
            }
        )
    return branch, gaps


def dpkg_failed(res: core.Result) -> bool:
    """dpkg-query could not answer. Exit 1 with only "no packages found matching" lines is an answer (none installed)."""
    if res.rc == 0:
        return False
    lines = [line for line in res.err.splitlines() if line.strip()]
    return res.rc != 1 or any("no packages found matching" not in line for line in lines)


def nvidia(ctx: Ctx) -> Signal:
    cfg = ctx.cfg
    dpkg = ctx.run(
        [
            "dpkg-query",
            "-W",
            "-f",
            "${Package} ${db:Status-Abbrev}\\n",
            "nvidia-driver-*",
            "linux-image-*-generic",
            "linux-modules-nvidia-*",
        ]
    )
    if dpkg_failed(dpkg):
        return Signal("probes.nvidia.unreadable", "warn", {"why": (dpkg.err.strip() or f"exit {dpkg.rc}")[-120:]})
    running = ctx.run(["uname", "-r"]).out.strip()
    root = Path(cfg["modules_root"])

    def has_module(kver: str) -> bool:
        try:
            return any((root / kver).rglob("nvidia.ko*"))
        except OSError:
            return False

    branch, gaps = nvidia_module_gaps(dpkg.out, running, has_module)
    if not branch:
        return Signal("probes.nvidia", "ok", {"detail": "No NVIDIA driver installed"})
    if not gaps:
        return Signal("probes.nvidia", "ok", {"branch": branch})
    names = ", ".join(
        f"{g['kernel']}{' (newest, default boot)' if g['newest'] else ' (running)' if g['running'] else ''}"
        for g in gaps
    )
    fields = {"branch": branch, "kernels": names, "package": gaps[-1]["package"]}
    if any(g["newest"] or g["running"] for g in gaps):
        return Signal("probes.nvidia.missing", "failed", fields)
    return Signal("probes.nvidia.fallback", "ok", fields, note=True)


def agent_chromes(ps_out: str) -> tuple[int, int]:
    """(browsers, RSS KiB) of automation-driven local Chrome: main processes started with remote debugging, plus
    every process sharing their user-data-dir. The owner's own desktop Chrome has no remote-debugging flag."""
    rows = []
    for line in ps_out.splitlines():
        parts = line.split(None, 2)
        if (
            len(parts) == 3
            and parts[0].isdigit()
            and parts[1].isdigit()
            and "chrome" in parts[2].split(" ", 1)[0]
        ):
            rows.append((int(parts[1]), parts[2]))
    data_dir = re.compile(r"--user-data-dir=(\S+)")
    mains = [
        args
        for _, args in rows
        if "--type=" not in args and re.search(r"--remote-debugging-(port|pipe)", args)
    ]
    dirs = {m.group(1) for args in mains if (m := data_dir.search(args))}
    rss = sum(
        kib
        for kib, args in rows
        if args in mains or ((m := data_dir.search(args)) and m.group(1) in dirs)
    )
    return len(mains), rss


def stopped_spans(
    detail: dict[str, Any] | None, name: str, now_ts: float, seen_ts: float | None = None
) -> list[tuple[float, float]]:
    """(from, to) spans the guest `name` was off on purpose, from the PVE guests detail (seen at `seen_ts`): each
    successful stop or shutdown task until the next start. A guest still off: until now, or until the snapshot when
    it showed the guest running, and never more than an hour past an old snapshot. [] when unknown."""
    if not name or not isinstance(detail, dict):
        return []
    guest = next(
        (g for g in detail.get("guests") or [] if isinstance(g, dict) and g.get("name") == name),
        None,
    )
    vmid = str(guest.get("vmid")) if guest else None
    tasks = (
        (detail.get("tasks") or {}).get(vmid)
        if vmid and isinstance(detail.get("tasks"), dict)
        else None
    )
    tasks = tasks if isinstance(tasks, list) else []
    spans: list[tuple[float, float]] = []
    off: float | None = None
    ok = [
        t
        for t in tasks
        if isinstance(t, dict) and t.get("ok") and isinstance(t.get("ts"), int | float)
    ]
    if (
        ok and ok[0].get("action") == "start"
    ):  # it was off before its first start in the history window
        off = (seen_ts if seen_ts is not None else now_ts) - HISTORY_S
    for t in ok:
        if t.get("action") in ("stop", "shutdown") and off is None:
            off = float(t["ts"])
        elif t.get("action") == "start" and off is not None:
            spans.append((off, float(t["ts"])))
            off = None
    last = (
        (detail.get("last") or {}).get(vmid)
        if vmid and isinstance(detail.get("last"), dict)
        else None
    )
    if (
        not ok
        and isinstance(last, dict)
        and last.get("ok")
        and last.get("action") in ("stop", "shutdown")
        and isinstance(last.get("ts"), int | float)
    ):
        off = float(last["ts"])
    if off is None:
        return spans
    end = now_ts
    if seen_ts is not None:
        end = seen_ts if guest and guest.get("status") == "running" else min(now_ts, seen_ts + 3600)
    return [*spans, (off, max(off, end))]


def count_fallbacks(
    lines: Sequence[str], now_ts: float, parked: Sequence[tuple[float, float]]
) -> tuple[int, int]:
    """(fallbacks in 24h, those while the browser VM was off on purpose)."""
    recent = while_off = 0
    for line in lines:
        try:
            at = float(json.loads(line).get("at_ms", 0)) / 1000
        except (ValueError, AttributeError, TypeError):
            continue
        if now_ts - at < 86400:
            if any(
                a - 60 <= at <= b + 120 for a, b in parked
            ):  # st browser saw it unreachable around the stop/start
                while_off += 1
            else:
                recent += 1
    return recent, while_off


def guests_detail(ctx: Ctx) -> tuple[dict[str, Any] | None, float | None]:
    name = ctx.cfg.get("guests_file")
    if not name:
        return None, None
    try:
        data = json.loads((core.STATE_PATH.parent / name).read_text())
        return data["details"], float(data["seen"])
    except (OSError, ValueError, KeyError, TypeError):
        return None, None


def browser(ctx: Ctx) -> Signal:
    cfg = ctx.cfg
    fallbacks = str(cfg.get("fallbacks_file") or "")
    text = ctx.read(fallbacks) if fallbacks else None
    lines = text.splitlines()[-500:] if text else []
    detail, seen = guests_detail(ctx)
    parked = stopped_spans(detail, str(cfg.get("browser_vm") or ""), ctx.now, seen)
    ps = ctx.run(["ps", "-eo", "pid=,rss=,args="])
    count, rss = agent_chromes(ps.out)
    recent, while_off = count_fallbacks(lines, ctx.now, parked)
    gib = rss / 2**20
    fields = {
        "count": count,
        "gib": f"{gib:.1f}",
        "recent": recent,
        "off": f" (+{while_off} while the browser VM was off on purpose)" if while_off else "",
    }
    if gib >= float(cfg["warn_rss_gib"]) or recent >= int(cfg["warn_fallbacks_24h"]):
        return Signal("probes.browser", "warn", fields)
    return Signal("probes.browser", "ok", fields, note=bool(count or recent or while_off))


def run(ctx: Ctx) -> list[Signal]:
    return [nvidia(ctx), browser(ctx)]
