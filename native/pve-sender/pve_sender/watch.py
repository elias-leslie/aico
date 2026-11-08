"""Local PVE checks use host-steward's existing evaluators and configuration."""
from __future__ import annotations

import subprocess
from pathlib import Path

import aico_status
from host_steward import core
from host_steward.checks import ecc, pve, thermal

from . import backup_guard


def local_rows(state: dict, now: float, machine: str) -> list[dict]:
    data = core.load_data()
    result = core.run_command(["bash", "-c", pve.SCRIPT], timeout=data["site"]["pve"]["ssh_timeout"])
    sections = pve.split_sections(result.out)
    if result.rc or "end" not in sections:
        raise RuntimeError("Local PVE checks did not finish.")
    rows = []
    for module in (pve, ecc, thermal):
        name = module.ID
        ctx = core.Ctx(cfg=data["checks"][name], site=data["site"], now=now,
                       state=state.setdefault(name, {}), cache={"pve": (sections, "")})
        if module is thermal:
            readings = thermal.sensors(thermal.parse_hwmon(sections.get("hwmon", "")), [], ctx.cfg)
            signals = [thermal.judge("PVE", readings, ctx.state.setdefault("hot", {}))] if readings else [
                core.Signal("thermal.unavailable", "warn", {"host": "PVE"})
            ]
        else:
            signals = module.run(ctx)
        item = core.make_row(name, signals, ctx.cfg, data["meanings"], machine, now, data["caps"])
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
        if module is thermal and backup_guard.DEFAULT_CONFIG.is_file():
            guard_cfg = backup_guard.config(backup_guard.DEFAULT_CONFIG)
            snapshot = backup_guard.load(Path(guard_cfg["runtime_dir"]) / "status.json")
            payload = backup_guard.notice_payload(guard_cfg, snapshot, now)
            previous = state.get("guard_episode")
            if (payload is None and previous and previous["phase"] == "unavailable"
                    and snapshot.get("mode") == "normal" and snapshot.get("admission_open") is True):
                # The daemon was absent, so it could not retain the sensor episode itself.
                payload = {**previous, "phase": "recovered", "admission_open": True,
                           "temperature_c": snapshot.get("temperature_c"),
                           "cpu_quota_percent": snapshot["cpu_quota_percent"]}
            if payload is not None:
                state["guard_episode"] = payload
                item["guard"] = payload
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
