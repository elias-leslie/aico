"""Deterministic rules over host-check observations. No planner, model call or command executor.

The existing space guard owns reclamation policy. Unknown problems stay visible for agents;
only configured hardware/owner actions ask the owner. An episode acts once and records its result.
"""

from __future__ import annotations

import json
import time
import tomllib
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any

import aico_status
from host_steward import core


def policy() -> dict[str, Any]:
    with (core.DATA_DIR / "rules.toml").open("rb") as handle:
        return tomllib.load(handle)


def decide(signal: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    code, state, fields = signal["code"], signal["state"], signal.get("fields", {})
    if state not in ("warn", "failed"):
        return {"route": "clear"}
    for pattern, ask in cfg["owner_codes"].items():
        if fnmatchcase(code, pattern):
            return {"route": "owner", "meaning": ask}
    if code == "storage.disk.space" and state == "failed":
        return {"route": "act", "argv": ["systemctl", "--no-ask-password", "start", cfg["space_guard_unit"]],
                "meaning": "Disk reserve is short; run the space guard."}
    units = fields.get("units", "")
    units = units.split(", ") if isinstance(units, str) else units
    if code == "ws.units.failed" and units and all(unit in cfg["restart_units"] for unit in units):
        return {"route": "act", "argv": ["systemctl", "--no-ask-password", "restart", *units],
                "meaning": "Restart the failed host service once."}
    return {"route": "agent", "meaning": next((text for pattern, text in cfg["agent_codes"].items()
            if fnmatchcase(code, pattern)), "Inspect this host finding and fix its cause.")}


def run(observations: dict[str, Any], saved: dict[str, Any], cfg: dict[str, Any], now: float,
        command=core.run_command) -> list[dict[str, Any]]:
    decisions = []
    live = set()
    for check, observation in observations.items():
        if now >= observation["valid_until"]:
            decisions.append({"check": check, "route": "stale", "meaning": "Check observations are old; run the check first."})
            continue
        for signal in observation["signals"]:
            key = f"{check}:{signal['code']}"
            decision = {"key": key, **decide(signal, cfg)}
            if decision["route"] == "clear":
                if saved.get(key, {}).get("route") == "owner":
                    decisions.append({"key": key, "route": "clear-owner", "meaning": "Host finding cleared."})
                continue
            if decision["route"] == "owner":
                saved[key] = {"route": "owner", "at": now}
            live.add(key)
            if decision["route"] == "act":
                previous = saved.get(key)
                if previous:
                    decision.update(route="agent", meaning="The first repair did not clear this finding; inspect its cause.", previous=previous)
                elif cfg["enabled"]:
                    result = command(decision["argv"])
                    saved[key] = {"at": now, "rc": result.rc}
                    decision["rc"] = result.rc
                else:
                    decision["route"] = "dry-run"
            decisions.append(decision)
    # Do not clear a repair episode merely because a check was stale or absent.
    fresh_checks = {check for check, o in observations.items() if now < o["valid_until"]}
    for key in list(saved):
        if key not in live and key.split(":", 1)[0] in fresh_checks:
            if saved[key].get("route") == "owner" and not any(d.get("key") == key for d in decisions):
                decisions.append({"key": key, "route": "clear-owner", "meaning": "Host finding cleared."})
            del saved[key]
    return decisions


def main(dry_run: bool = False) -> int:
    cfg = policy()
    state = core.load_state()
    path = Path(cfg["state_file"])
    saved = json.loads(path.read_text()) if path.exists() else {}
    if dry_run:
        cfg["enabled"] = False
    decisions = run(state.get("observations", {}), saved, cfg, time.time())
    if not dry_run:
        core.write_json(path, saved, mode=0o600)
        now = time.time()
        rows = []
        for decision in decisions:
            if decision["route"] in ("owner", "clear-owner"):
                rows.append({"id": f"{aico_status.machine_id()}/rule-{decision['key']}",
                             "what": "Host needs attention", "kind": "check", "machine": aico_status.machine_id(),
                             "state": "warn" if decision["route"] == "owner" else "ok", "meaning": decision["meaning"], "last_run": core.iso_time(now), "next_run": core.iso_time(now + 120),
                             "actions": [{"kind": "look", "ref": decision["meaning"], "owner_only": True}]})
        rows.append({"id": f"{aico_status.machine_id()}/host-rules", "what": "Host rules", "kind": "job",
                     "machine": aico_status.machine_id(), "state": "warn" if any(d["route"] == "stale" for d in decisions) else "ok",
                     "meaning": f"Checked {len(decisions)} open findings; decisions recorded locally.",
                     "last_run": core.iso_time(now), "next_run": core.iso_time(now + 120),
                     "actions": [{"kind": "log", "ref": "journalctl -u host-steward-rules.service -n 100 --no-pager"}]})
        aico_status.report(rows)
    print(json.dumps({"decisions": decisions}))
    return 0
