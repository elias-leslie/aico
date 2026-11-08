"""Local PVE checks use host-steward's existing evaluators and configuration."""
from __future__ import annotations

import subprocess
import time
from pathlib import Path

import aico_status
from host_steward import core
from host_steward.checks import ecc, pve, thermal

from . import backup_guard


def local_rows(state: dict, now: float, machine: str) -> list[dict]:
    started = time.monotonic()
    data = core.load_data()
    result = core.run_command(["bash", "-c", pve.SCRIPT], timeout=data["site"]["pve"]["ssh_timeout"])
    sections = pve.split_sections(result.out)
    if result.rc or "end" not in sections:
        raise RuntimeError("Local PVE checks did not finish.")
    # Collection can span a sensor tick. Judge the latest snapshot at collection completion.
    guard_now = now + time.monotonic() - started
    guard_cfg = backup_guard.config(backup_guard.DEFAULT_CONFIG) if backup_guard.DEFAULT_CONFIG.is_file() else None
    guard_snapshot = backup_guard.load(Path(guard_cfg["runtime_dir"]) / "status.json") if guard_cfg else {}
    guard_temperature = guard_snapshot.get("temperature_c")
    guard_owns_cpu = bool(guard_cfg and backup_guard.fresh(guard_cfg, guard_snapshot, guard_now)
                          and isinstance(guard_temperature, int | float)
                          and not isinstance(guard_temperature, bool) and 0 < guard_temperature <= 150
                          and guard_snapshot.get("mode") in ("normal", "hot", "critical"))
    rows = []
    for module in (pve, ecc, thermal):
        name = module.ID
        ctx = core.Ctx(cfg=data["checks"][name], site=data["site"], now=now,
                       state=state.setdefault(name, {}), cache={"pve": (sections, "")})
        if module is thermal:
            readings = thermal.sensors(thermal.parse_hwmon(sections.get("hwmon", "")), [], ctx.cfg)
            available = bool(readings)
            if guard_owns_cpu:
                readings = [reading for reading in readings if reading["name"] != "CPU"]
            signals = [thermal.judge("PVE", readings, ctx.state.setdefault("hot", {}))] if available else [
                core.Signal("thermal.unavailable", "warn", {"host": "PVE"})
            ]
        else:
            signals = module.run(ctx)
        item = core.make_row(name, signals, ctx.cfg, data["meanings"], machine, now, data["caps"])
        if module is thermal and guard_owns_cpu:
            item["what"] = "Other temperatures"
        push_codes = ctx.cfg.get("push_codes")
        if module is thermal:
            # Thermal episodes use Aico's typed notice route and the owner's Settings choices.
            # A failed reading must never fall through to severity-based native phone sends.
            state.setdefault("push_failed", {})[item["id"]] = False
        elif push_codes is not None:
            state.setdefault("push_failed", {})[item["id"]] = any(
                s.state == "failed" and s.code in push_codes for s in signals
            )
        item["actions"] = [{"kind": "log", "ref": "journalctl -u aico-pve-sender.service"}]
        rows.append(aico_status.check_row(item))
    if guard_cfg:
        item = backup_guard.reconcile_row(guard_cfg, guard_snapshot, guard_now, machine)
        state.setdefault("push_failed", {})[item["id"]] = False
        rows.append(aico_status.check_row(item))
    return rows


def door_probe(alias: str, workstation_addr: str) -> str | None:
    conf = subprocess.run(["ssh", "-G", alias], capture_output=True, text=True, timeout=10, check=False)
    if conf.returncode or f"hostname {alias}" in conf.stdout.splitlines():
        return None
    done = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias],
                          capture_output=True, text=True, timeout=40, check=False,
                          stdin=subprocess.DEVNULL)
    if "door-ok" in done.stdout.split():
        return "ok"
    if done.returncode != 255:
        return "home"
    ping = subprocess.run(["ping", "-c", "2", "-W", "2", workstation_addr],
                          capture_output=True, timeout=10, check=False)
    return "door" if ping.returncode == 0 else "offline"
