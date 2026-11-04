"""Temperatures: CPU, NVMe, GPU and any sensor with its own critical limit, on the workstation and on PVE.

Port of ns/checks/thermal.py. A sensor over its warn limit warns on the second pass in a row (one hot sample during
a build is normal); critical limit, or GPU thermal slowdown twice, fails. A missing sensor is never shown as 0.
Which sensors were hot last pass is kept in this check's state.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from host_steward.checks.pve import collect
from host_steward.core import Ctx, Signal

ID = "thermal"


def parse_hwmon(text: str) -> list[dict[str, Any]]:
    """'T chip label milli max crit' lines -> readings in C (max/crit 0: not published)."""
    out = []
    for line in text.splitlines():
        p = line.split()
        if len(p) != 6 or p[0] != "T":
            continue
        try:
            out.append(
                {
                    "chip": p[1],
                    "label": "" if p[2] == "-" else p[2].replace("_", " "),
                    "c": int(p[3]) / 1000,
                    "max": int(p[4]) / 1000,
                    "crit": int(p[5]) / 1000,
                }
            )
        except ValueError:
            continue
    return out


def read_hwmon(root: str) -> list[dict[str, Any]]:
    def read(path: Path, default: str) -> str:
        try:
            return path.read_text().strip() or default
        except OSError:
            return default

    lines = []
    for hw in sorted(Path(root).glob("hwmon*")):
        name = read(hw / "name", "unknown")
        for t in sorted(hw.glob("temp*_input")):
            base = str(t)[: -len("_input")]
            label = read(Path(base + "_label"), "-").replace(" ", "_")
            lines.append(f"T {name} {label} {read(t, 'x')} {read(Path(base + '_max'), '0')} {read(Path(base + '_crit'), '0')}")
    return parse_hwmon("\n".join(lines))


def parse_nvidia(text: str) -> list[dict[str, Any]]:
    out = []
    for line in text.splitlines():
        p = [x.strip() for x in line.split(",")]
        if len(p) == 4:
            try:
                out.append({"c": float(p[1]), "slowdown": "Active" in (p[2], p[3])})
            except ValueError:
                continue
    return out


def sensors(hwmon: list[dict[str, Any]], gpus: list[dict[str, Any]], cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """The readings worth judging with their limits: one CPU package sensor per chip, NVMe composites, GPUs, and any
    other sensor that publishes a critical limit."""
    chips = cfg["chips"]
    out: list[dict[str, Any]] = []
    seen_cpu: set[str] = set()
    nvme = 0
    for r in hwmon:
        chip, label = r["chip"], r["label"]
        info = chips.get(chip)
        if info:
            kind, warn, crit = info["kind"], float(info["warn"]), float(info["crit"])
            if kind == "CPU":
                if chip in seen_cpu or (label and label not in cfg["cpu_labels"]):
                    continue
                seen_cpu.add(chip)
                name = "CPU"
            elif kind == "NVMe":
                if label and label != "Composite":
                    continue
                nvme += 1
                name = f"NVMe {nvme}" if nvme > 1 else "NVMe"
                warn, crit = (r["max"] if r["max"] > 0 else warn), (r["crit"] if r["crit"] > 0 else crit)
            else:
                name = kind
        elif r["crit"] > 0:
            name, crit = f"{chip} {label}".strip(), r["crit"]
            warn = r["max"] if 0 < r["max"] < crit else crit - float(cfg["crit_only_margin"])
        else:
            continue
        if 0 < r["c"] <= 150:  # unreadable or bogus sensor: not a reading
            out.append({"name": name, "c": r["c"], "warn": warn, "crit": crit, "slowdown": False})
    for i, g in enumerate(gpus):
        out.append(
            {"name": "GPU" if len(gpus) == 1 else f"GPU {i + 1}", "c": g["c"], "warn": cfg["gpu_warn"], "crit": cfg["gpu_crit"], "slowdown": g["slowdown"]}
        )
    return out


def judge(label: str, readings: list[dict[str, Any]], state: dict[str, Any]) -> Signal:
    """One signal for a host: failed at the critical limit, warn when hot on two passes in a row."""
    previous = set(state.get(label, []))
    hot = {s["name"] for s in readings if s["c"] >= s["warn"] or s["slowdown"]}
    state[label] = sorted(hot)
    crit = [s for s in readings if s["c"] >= s["crit"] or (s["slowdown"] and s["name"] in previous)]
    warn = [s for s in readings if s["name"] in hot and s["name"] in previous and s not in crit]
    top = ", ".join(f"{s['name']} {s['c']:.0f}C" for s in readings[:3])
    if crit:
        return Signal("thermal.hot", "failed", {"host": label, "sensors": ", ".join(f"{s['name']} {s['c']:.0f}C" for s in crit)})
    if warn:
        return Signal("thermal.hot", "warn", {"host": label, "sensors": ", ".join(f"{s['name']} {s['c']:.0f}C" for s in warn)})
    return Signal("thermal.hot", "ok", {"host": label, "top": top})


def run(ctx: Ctx) -> list[Signal]:
    cfg = ctx.cfg
    out = []
    ws_hot = ctx.state.setdefault("hot", {})
    gpus = parse_nvidia(
        ctx.run(
            ["nvidia-smi", "--query-gpu=name,temperature.gpu,clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.sw_thermal_slowdown", "--format=csv,noheader,nounits"],
            timeout=20,
        ).out
    )
    readings = sensors(read_hwmon(cfg["hwmon_root"]), gpus, cfg)
    if readings:
        out.append(judge("Workstation", readings, ws_hot))
    else:
        out.append(Signal("thermal.unavailable", "warn", {"host": "Workstation"}))
    sections, _ = collect(ctx)
    if sections is None or "hwmon" not in sections:
        out.append(Signal("thermal.unavailable", "warn", {"host": "PVE"}))
    else:
        pve = sensors(parse_hwmon(sections["hwmon"]), [], cfg)
        out.append(judge("PVE", pve, ws_hot) if pve else Signal("thermal.unavailable", "warn", {"host": "PVE"}))
    return out
