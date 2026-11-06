"""Memory: stalls since the last run, memory kills in the last day, and whether memctl and Tether's guard still report.

The memory pressure (the 15-minute stall delta), the memory kill incidents and the memctl / Tether-guard
heartbeat probes. The stall rule reads the PSI `total=` counters, so a
spike between runs is not missed; M5a-1's workstation check keeps the instant avg10 reading. The kill incidents come
from memctl's record (its live path), the kernel journal, the user manager's unit results and Tether's crash
records. The memctl heartbeat read is [checks.memory.memctl]'s, and the row names that controller and its unit;
Tether's guard is read at its live heartbeat path.
"""

from __future__ import annotations

import contextlib
import json
import pwd
from pathlib import Path
from typing import Any

from host_steward import memalerts, memevents
from host_steward.core import Ctx, Signal
from host_steward.memstate import parse_meminfo, parse_psi

ID = "memory"


def paths(ctx: Ctx) -> dict[str, Path]:
    uid = int(ctx.cfg["owner_uid"])
    home = ctx.cfg.get("home")
    if not home:
        try:
            home = pwd.getpwuid(uid).pw_dir
        except KeyError:
            home = f"/home/{ctx.site.get('owner', {}).get('user', 'kasadis')}"
    fill = {"uid": uid, "home": home}
    ctl = ctx.cfg["memctl"]
    return {
        **{key: Path(str(ctx.cfg[key]).format(**fill)) for key in ("events", "guard", "recoveries")},
        **{key: Path(str(ctl[key]).format(**fill)) for key in ("heartbeat", "admission")},
    }


def stall_totals(text: str) -> dict[str, int]:
    """/proc/pressure/memory or a cgroup's memory.pressure -> {'some': total_us, 'full': total_us}."""
    return {
        k.removesuffix("_total"): int(v) for k, v in parse_psi(text).items() if k.endswith("_total")
    }


def cgroup_stalls(roots: list[str]) -> dict[str, int]:
    """{cgroup name: its own memory.pressure 'some' total (us)} for the direct children of each root."""
    out: dict[str, int] = {}
    for root in roots:
        with contextlib.suppress(OSError):
            for d in Path(root).iterdir():
                with contextlib.suppress(OSError, ValueError):
                    if d.is_dir():
                        out[d.name] = stall_totals((d / "memory.pressure").read_text()).get(
                            "some", 0
                        )
    return out


def stall(ctx: Ctx) -> Signal:
    """Memory stall time since the previous run as a share of wall time, with the most stalled cgroups."""
    cfg = ctx.cfg
    psi, meminfo = ctx.read(cfg["psi_memory"]), ctx.read(cfg["meminfo"])
    if psi is None or meminfo is None:
        return Signal("memory.stall.unreadable", "warn")
    uid = int(cfg["owner_uid"])
    user = cfg["cgroup_user"].format(uid=uid)
    cgroups = cgroup_stalls([f"{user}/app.slice", f"{user}/session.slice", cfg["cgroup_system"]])
    tot = stall_totals(psi)
    info = parse_meminfo(meminfo)
    avail = f"{info.get('MemAvailable', 0) / 2**30:.1f}/{info.get('MemTotal', 0) / 2**30:.1f}"
    prev = ctx.state.get("stall") or {}
    ctx.state["stall"] = {
        "at": ctx.now,
        "some": tot.get("some", 0),
        "full": tot.get("full", 0),
        "cgroups": cgroups,
    }
    elapsed = ctx.now - float(prev.get("at", 0))
    if (
        not prev or elapsed <= 0 or tot.get("full", 0) < int(prev.get("full", 0))
    ):  # first run or counters reset (reboot)
        return Signal("memory.stall", "ok", {"avail": avail, "baseline": True})
    full_pct = 100 * (tot.get("full", 0) - int(prev.get("full", 0))) / 1e6 / elapsed
    some_pct = 100 * (tot.get("some", 0) - int(prev.get("some", 0))) / 1e6 / elapsed
    before = prev.get("cgroups") or {}
    top = sorted(
        (
            (n, (v - int(before.get(n, 0))) / 1e6)
            for n, v in cgroups.items()
            if n in before and v > int(before.get(n, 0))
        ),
        key=lambda r: -r[1],
    )[:3]
    warn = full_pct >= cfg["pressure_warn_full_pct"] or some_pct >= cfg["pressure_warn_some_pct"]
    fields = {
        "min": f"{elapsed / 60:.0f}",
        "full": f"{full_pct:.1f}",
        "some": f"{some_pct:.1f}",
        "avail": avail,
        "top": ", ".join(f"{memalerts.unit_name(n)} {round(s, 1):g}s" for n, s in top)
        or "no one unit stands out",
    }
    return Signal("memory.stall", "warn" if warn else "ok", fields)


def load_json(ctx: Ctx, path: Path) -> Any:
    text = ctx.read(str(path))
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None


def alive(
    ctx: Ctx, code: str, last: float | None, state: str | None, who: dict[str, str]
) -> Signal:
    """who: the reporter's fields for the row (name, unit, or who)."""
    stale = float(ctx.cfg["heartbeat_stale_s"])
    if last is not None and ctx.now - last <= stale:
        return Signal(
            code, "ok", {**who, "ago": f"{ctx.now - last:.0f}", "state": state or "unknown"}
        )
    ago = (
        f"last reported {(ctx.now - last) / 60:.0f} min ago"
        if last
        else "has not reported since boot"
    )
    return Signal(code, "warn", {**who, "ago": ago})


def number(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def controllers(ctx: Ctx) -> list[Signal]:
    p = paths(ctx)
    heart, adm = load_json(ctx, p["heartbeat"]), load_json(ctx, p["admission"])
    seen = [
        t
        for d, k in ((heart, "ts"), (adm, "updated_at"))
        if isinstance(d, dict) and (t := number(d.get(k))) is not None
    ]
    state = (
        heart.get("state")
        if isinstance(heart, dict)
        else (adm or {}).get("state")
        if isinstance(adm, dict)
        else None
    )
    guard = load_json(ctx, p["guard"])
    guard_ts = number(guard.get("ts")) if isinstance(guard, dict) else None
    ctl = ctx.cfg["memctl"]
    return [
        alive(
            ctx,
            "memory.memctl_alive",
            max(seen) if seen else None,
            state,
            {"name": ctl["name"], "unit": ctl["unit"]},
        ),
        alive(ctx, "memory.guard_alive", guard_ts, None, {"who": "Tether's memory guard"}),
    ]


def kills(ctx: Ctx) -> list[Signal]:
    cfg = ctx.cfg
    p = paths(ctx)
    uid = int(cfg["owner_uid"])
    since = f"@{int(ctx.now - float(cfg['window_h']) * 3600)}"
    base = ["journalctl", "-o", "json", "-q", "--no-pager", "--since", since]
    user_units = [f"_SYSTEMD_UNIT=user@{uid}.service"]
    # no -g: it exits 1 both when nothing matched and on a real failure; kernel_lines picks the kill lines
    kern = ctx.run([*base, "--output-fields=MESSAGE", "-k"], timeout=30)
    units = ctx.run([*base, *user_units, f"MESSAGE_ID={memalerts.UNIT_FAILED}"], timeout=30)
    # -g here (a day of Tether's own lines is large): exit 1 with no output is nothing matched, which is read
    daemons = ctx.run(
        [
            *base,
            "--output-fields=MESSAGE,_PID",
            *user_units,
            "SYSLOG_IDENTIFIER=tether",
            "SYSLOG_IDENTIFIER=node",
            "-g",
            memalerts.TETHER_LINES,
        ],
        timeout=30,
    )
    recoveries: list[dict[str, Any]] = []
    with contextlib.suppress(ValueError, TypeError):
        raw = ctx.read(str(p["recoveries"]))
        recoveries = memalerts.tether_recoveries(json.loads(raw)) if raw else []
    incs = memalerts.incidents(
        memevents.read_all([p["events"]]),
        memevents.parse_kernel(memevents.kernel_lines(kern.out.splitlines())),
        memalerts.journal_units(units.out.splitlines()),
        recoveries,
        ctx.now,
        memalerts.test_panes(daemons.out.splitlines()),
        window_s=float(cfg["window_h"]) * 3600,
        match_s=float(cfg["match_s"]),
        loop_n=int(cfg["kill_loop_count"]),
        loop_s=60 * float(cfg["kill_loop_window_min"]),
        tether_grace_s=float(cfg["tether_grace_s"]),
    )
    # unread only on a real failure: journalctl's exit status, or output that does not parse
    sources = {
        "kernel journal": memalerts.journal_read(kern.rc, kern.out),
        "unit journal": memalerts.journal_read(units.rc, units.out),
        "Tether journal": memalerts.journal_read(
            0 if daemons.rc == 1 and not daemons.out.strip() else daemons.rc, daemons.out
        ),
        "memctl record": p["events"].exists()
        or p["events"].with_name(p["events"].name + ".1").exists(),
    }
    unread = [k for k, ok in sources.items() if not ok]
    loud = [
        i
        for i in incs
        if i["class"] in memalerts.PUSH_CLASSES and i.get("tether_state") != "recovered"
    ]
    shown = loud + [i for i in incs if i not in loud]
    n = sum(1 for i in incs if i["class"] in ("tool-kill", "agent-lost", "pane-stopped"))
    fields = {
        "n": n,
        "plural": "" if n == 1 else "s",
        "hours": f"{float(cfg['window_h']):g}",
        "list": "; ".join(memalerts.line(i) for i in shown[:4]),
        "unread": ", ".join(unread),
    }
    out = [
        Signal("memory.kills", "warn", fields)
        if loud
        else Signal("memory.kills", "ok", fields, note=bool(incs))
    ]
    if unread:
        out.append(Signal("memory.kills.unread", "ok", fields, note=True))
    return out


def run(ctx: Ctx) -> list[Signal]:
    return [stall(ctx), *kills(ctx), *controllers(ctx)]
