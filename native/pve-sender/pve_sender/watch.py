"""Local PVE checks use host-steward's existing evaluators and configuration."""
from __future__ import annotations

import subprocess

import aico_status
from host_steward import core
from host_steward.checks import ecc, pve


def local_rows(state: dict, now: float, machine: str) -> list[dict]:
    data = core.load_data()
    result = core.run_command(["bash", "-c", pve.SCRIPT], timeout=data["site"]["pve"]["ssh_timeout"])
    sections = pve.split_sections(result.out)
    if result.rc or "end" not in sections:
        raise RuntimeError("Local PVE checks did not finish.")
    rows = []
    for module in (pve, ecc):
        name = module.ID
        ctx = core.Ctx(cfg=data["checks"][name], site=data["site"], now=now,
                       state=state.setdefault(name, {}), cache={"pve": (sections, "")})
        signals = module.run(ctx)
        item = core.make_row(name, signals, ctx.cfg, data["meanings"], machine, now, data["caps"])
        push_codes = ctx.cfg.get("push_codes")
        if push_codes is not None:
            state.setdefault("push_failed", {})[item["id"]] = any(
                s.state == "failed" and s.code in push_codes for s in signals
            )
        item["actions"] = [{"kind": "log", "ref": "journalctl -u aico-pve-sender.service"}]
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
