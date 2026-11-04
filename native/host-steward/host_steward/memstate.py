"""The host's memory and disk state, and the admission file that publishes it (contract v1).

Port of the pure part of ns/memctl.py. States, with hysteresis so they do not flap (numbers are the [memctl]
table in data/checks.toml):
  green  enough available memory, swap and PSI calm   -> admit
  amber  tight: available below amber_avail, PSI up, or swap high while PSI shows stalls  -> admission closed
  red    critical: available below red_avail, or high PSI below psi_red_matters_avail      -> admission closed
Disk is rated per internal disk against the storage check's lines (SummitFlow's free-space reserve), with
admission_margin_gib of hysteresis. The published state is the worse of memory and disk; memory_state and
memory_reason keep memory's own (Tether's memory guard and SummitFlow's memory issue read them).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

G = 2**30
STATES = ("green", "amber", "red")


@dataclass(frozen=True)
class Limits:
    """The [memctl] thresholds, bytes for sizes (the data file says GiB), PSI and swap in percent."""

    amber_avail: float
    green_avail: float
    red_avail: float
    amber_from_red_avail: float
    amber_psi: float
    green_psi: float
    red_psi: float
    amber_from_red_psi: float
    amber_swap: float
    green_swap: float
    swap_matters_avail: float
    swap_matters_psi: float
    green_swap_matters_psi: float
    psi_red_matters_avail: float
    expires_s: int

    @classmethod
    def from_cfg(cls, cfg: dict[str, Any]) -> Limits:
        def gib(key: str) -> float:
            return float(cfg[key]) * G

        return cls(
            amber_avail=gib("amber_avail_gib"),
            green_avail=gib("green_avail_gib"),
            red_avail=gib("red_avail_gib"),
            amber_from_red_avail=gib("amber_from_red_avail_gib"),
            amber_psi=float(cfg["amber_psi"]),
            green_psi=float(cfg["green_psi"]),
            red_psi=float(cfg["red_psi"]),
            amber_from_red_psi=float(cfg["amber_from_red_psi"]),
            amber_swap=float(cfg["amber_swap"]),
            green_swap=float(cfg["green_swap"]),
            swap_matters_avail=gib("swap_matters_avail_gib"),
            swap_matters_psi=float(cfg["swap_matters_psi"]),
            green_swap_matters_psi=float(cfg["green_swap_matters_psi"]),
            psi_red_matters_avail=gib("psi_red_matters_avail_gib"),
            expires_s=int(cfg["expires_s"]),
        )


@dataclass(frozen=True)
class Lines:
    """Free-space lines of one internal disk, GiB."""

    reserve: float
    warn: float  # amber below (counting the ballast as free)
    crit: float  # critical below; the space guard's reclaim tiers run below it
    floor: float  # critical at or below, whatever the reserve

    def pressured(self, free_gib: float) -> bool:
        return free_gib < self.crit or free_gib <= self.floor


def lines(storage_cfg: dict[str, Any]) -> Lines:
    """The storage check's lines from [checks.storage]: reserve, reserve + warn margin, reserve + capture peak, floor."""
    reserve = float(storage_cfg["reserve_gib"])
    return Lines(
        reserve,
        reserve + float(storage_cfg["warn_margin_gib"]),
        reserve + float(storage_cfg["capture_peak_gib"]),
        float(storage_cfg["critical_floor_gib"]),
    )


def parse_meminfo(text: str) -> dict[str, int]:
    """/proc/meminfo -> {key: bytes}."""
    out = {}
    for line in text.splitlines():
        key, _, value = line.partition(":")
        if value.split():
            out[key] = int(value.split()[0]) * 1024
    return out


def parse_psi(text: str) -> dict[str, float]:
    """/proc/pressure/memory -> {'some_avg10': .., 'some_avg60': .., 'full_avg10': .., ..., 'full_total': ..}."""
    out: dict[str, float] = {}
    for line in text.splitlines():
        kind, *kv = line.split()
        for k, _, v in (x.partition("=") for x in kv):
            out[f"{kind}_{k}"] = float(v)
    return out


def metrics(meminfo: str, psi: str) -> dict[str, float]:
    m, p = parse_meminfo(meminfo), parse_psi(psi)
    swap_total = m.get("SwapTotal", 0)
    swap_pct = 100.0 * (swap_total - m.get("SwapFree", 0)) / swap_total if swap_total else 0.0
    return {
        "avail": float(m.get("MemAvailable", 0)),
        "swap_pct": swap_pct,
        "psi_some_avg60": p.get("some_avg60", 0.0),
        "psi_full_avg10": p.get("full_avg10", 0.0),
    }


def classify(prev: str, m: dict[str, float], lim: Limits) -> str:
    """Next state from the previous one; a worse state is left only once the better state's margin is reached."""
    psi = max(m["psi_some_avg60"], m["psi_full_avg10"])
    avail = m["avail"]
    swap_psi = lim.green_swap_matters_psi if prev in ("amber", "red") else lim.swap_matters_psi
    swap = m["swap_pct"] if avail < lim.swap_matters_avail and psi >= swap_psi else 0.0
    red_psi = psi if avail < lim.psi_red_matters_avail else 0.0
    if avail < lim.red_avail or red_psi > lim.red_psi:
        return "red"
    if prev == "red" and (avail < lim.amber_from_red_avail or red_psi > lim.amber_from_red_psi):
        return "red"
    if avail < lim.amber_avail or psi >= lim.amber_psi or swap > lim.amber_swap:
        return "amber"
    if prev in ("amber", "red") and (
        avail < lim.green_avail or psi >= lim.green_psi or swap >= lim.green_swap
    ):
        return "amber"
    return "green"


def reason(state: str, m: dict[str, float], lim: Limits) -> str:
    psi = max(m["psi_some_avg60"], m["psi_full_avg10"])
    # full swap without stalls is parked pages, which classify() ignores; say so rather than look like the cause
    parked = (
        " (parked, no stalls)"
        if m["avail"] >= lim.swap_matters_avail or psi < lim.green_swap_matters_psi
        else ""
    )
    facts = f"{m['avail'] / G:.1f} GiB available, swap {m['swap_pct']:.0f}%{parked}, memory PSI {psi:.1f}"
    return {
        "green": f"Enough memory: {facts}",
        "amber": f"Memory is tight: {facts}; defer heavy work",
        "red": f"Memory is critical: {facts}; defer heavy work, Tether may kill the largest agent tool job",
    }[state]


def disk_state(prev: str, free: int, ballast: int, ln: Lines, margin_gib: float) -> str:
    """Next disk state of one internal disk; leaving a worse state needs margin_gib more free."""
    red_line, eff, margin = max(ln.crit, ln.floor) * G, free + ballast, margin_gib * G
    if ln.pressured(free / G) or (prev == "red" and free < red_line + margin):
        return "red"
    if eff < ln.warn * G or (prev in ("amber", "red") and eff < ln.warn * G + margin):
        return "amber"
    return "green"


def disk_reason(d: dict[str, Any]) -> str:
    if d.get("state") not in STATES or d.get("free_bytes") is None:
        return f"Disk unreadable: {d.get('path')}"
    free, ballast, path = d["free_bytes"] / G, d["ballast_bytes"] / G, d["path"]
    # amber counts the space guard's releasable ballast as free, so show the sum it is rated on
    held = f" + {ballast:.0f} GiB ballast = {free + ballast:.1f}" if ballast else ""
    warn, red = d["warn_bytes"] / G, d["floor_bytes"] / G
    return {
        "green": f"Enough disk: {path} has {free:.1f} GiB free",
        "amber": f"Disk is tight: {path} has {free:.1f} GiB free{held}, amber below {warn:g}; defer heavy work",
        "red": f"Disk is critical: {path} has {free:.1f} GiB free, red below {red:g} (SummitFlow pauses backups "
        f"there); defer heavy work",
    }[d["state"]]


def rank(state: str) -> int:
    """green 0, amber 1, red 2; unknown -1 (never the worse one)."""
    return STATES.index(state) if state in STATES else -1


def worse(a: str, b: str) -> str:
    return max(a, b, key=rank)


def admission(
    state: str,
    m: dict[str, float],
    now: float,
    offload: str | None,
    lim: Limits,
    disk: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The admission file contract (v1). state is memory's; the published state is the worse of it and disk's (an
    unreadable disk leaves memory's), and the reason leads with the worse one."""
    disk_level = disk["state"] if disk and disk.get("state") in STATES else "green"
    overall, text = worse(state, disk_level), reason(state, m, lim)
    if disk and disk_level != "green":
        dtext = disk_reason(disk)
        if state == "green":
            text = dtext
        else:  # both: the facts of each, then the action once (memory's, which may name Tether's kill)
            mem_facts, _, action = text.partition("; defer heavy work")
            disk_facts = dtext.partition("; defer heavy work")[0]
            # the worse leads; a red tie leads with the disk so it survives readers that cut at 160 characters
            disk_first = rank(disk_level) > rank(state) or disk_level == state == "red"
            first, second = (disk_facts, mem_facts) if disk_first else (mem_facts, disk_facts)
            text = f"{first}; {second}; defer heavy work{action}"
    return {
        "v": 1,
        "state": overall,
        "admit": overall == "green",
        "reason": text,
        "updated_at": int(now),
        "expires_at": int(now) + lim.expires_s,
        "memory_state": state,
        "memory_reason": reason(state, m, lim),
        "mem_available_gib": round(m["avail"] / G, 2),
        "swap_used_pct": round(m["swap_pct"], 1),
        "psi_full_avg10": m["psi_full_avg10"],
        "psi_some_avg60": m["psi_some_avg60"],
        "disk": disk,
        "offload": offload if overall != "green" else None,
    }


def anon_bytes(stat_text: str) -> int:
    for line in stat_text.splitlines():
        key, _, value = line.partition(" ")
        if key == "anon":
            return int(value)
    return 0


def gib(n: float | None) -> str:
    return f"{(n or 0) / G:.1f} GiB"
