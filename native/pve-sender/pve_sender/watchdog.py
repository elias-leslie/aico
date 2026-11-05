"""Two independent heartbeats, one outage alarm, and local checks even with Aico down."""
from __future__ import annotations

import math
import secrets
import socket
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

import aico_status

from . import sender, trim, watch
from .state import read, write


def iso(at: float) -> str:
    return aico_status.utc_text(datetime.fromtimestamp(at, UTC))


def age(at, now: float, boot: float, started: float) -> float | None:
    """Count only silence observed on this boot. Invalid/future stamps are unknown."""
    if not isinstance(at, int | float) or isinstance(at, bool) or not math.isfinite(at) or at > now:
        return None
    return max(0.0, now - max(at, min(boot, now), started))


def decision(heartbeats: dict, state: dict, cfg: dict, now: float, boot: float) -> tuple[bool, dict]:
    started = state.setdefault("started", now)
    ages = {name: age(heartbeats.get(name, {}).get("at"), now, boot, started)
            for name in cfg["sources"]}
    grace = max(0.0, now - max(started, min(boot, now)))
    silent = all((value if value is not None else grace) > cfg["window_s"] for value in ages.values())
    return silent, ages


def row(cfg: dict, suffix: str, what: str, status: str, meaning: str, now: float) -> dict:
    return {"id": f"{socket.gethostname().split('.')[0]}/{suffix}", "what": what, "kind": "service",
            "machine": socket.gethostname().split('.')[0].lower(), "state": status, "meaning": meaning[:300],
            "last_run": iso(now), "next_run": iso(now + cfg["tick_s"] + cfg["slack_s"]),
            "actions": [{"kind": "log", "ref": "journalctl -u aico-pve-sender.service"}]}


def transition(state: dict, key: str, active: bool, alarm: dict, recovery: dict, send) -> bool:
    """Only accepted sends change state. A held alarm stays deduplicated until recovery is sent."""
    pending = state.setdefault("alarms", {})
    deliveries = state.setdefault("deliveries", {})
    if active == bool(pending.get(key)) and key not in deliveries:
        return True
    event = deliveries.get(key)
    if not event or event["active"] != active:
        event = {"active": active, "id": secrets.token_hex(12)}
        deliveries[key] = event
    notice = alarm if active else recovery
    result = send({**notice, "key": key, "delivery_id": event["id"]})
    state["last_send"] = result
    if result.get("accepted", 0) and active:
        pending[key] = True
    if result["ok"]:
        deliveries.pop(key, None)
        if active:
            pending[key] = True
        else:
            pending.pop(key, None)
    return bool(result["ok"])


def tick(cfg: dict, *, now: float | None = None, boot: float | None = None,
         send=None, local=None, door=None, publish=True, test=False) -> dict:
    now = time.time() if now is None else now
    if boot is None:
        boot = now - float(Path("/proc/uptime").read_text().split()[0])
    directory = Path(cfg["state_dir"])
    state_path = directory / "state.json"
    state = read(state_path, {})
    heartbeats = read(directory / "heartbeats.json", {})
    silent, ages = decision(heartbeats, state, cfg, now, boot)
    outage_key = "pve-sender:test" if test else "pve-sender:outage"
    opened = bool(state.get("alarms", {}).get(outage_key) or state.get("deliveries", {}).get(outage_key))
    stamps = [v.get("at") for v in heartbeats.values() if isinstance(v, dict)]
    latest = max((at for at in stamps if isinstance(at, int | float) and not isinstance(at, bool)
                  and math.isfinite(at) and at <= now), default=0)
    if opened and (latest <= state.get("outage_seen", latest) or now - latest > cfg["window_s"]):
        silent = True  # reboot grace alone is never proof of recovery
    elif silent and not opened:
        state["outage_seen"] = latest
    prefix = "TEST (ignore): " if test else ""
    real_send = send or (lambda notice: sender.send(cfg, notice, now))

    def deliver(notice):
        write(state_path, state)  # stable delivery id survives a crash before transport returns
        return real_send(notice)

    good = transition(state, outage_key, silent,
                      {"title": prefix + "Aico stopped checking in", "body": "Neither the workstation nor Aico on CT 190 checked in within the alarm window. Proxmox sent this directly.", "severity": "warning" if test else "critical"},
                      {"title": prefix + "Aico is checking in again", "body": "A heartbeat resumed. Proxmox has closed the outage alarm.", "severity": "ok"}, deliver)
    write(state_path, state)
    machine_row = row(cfg, "machine", "Proxmox host", "ok", "The Proxmox watchdog is reporting.", now)
    machine_row["kind"] = "machine"
    rows = [machine_row, trim.status_row(cfg, now)]
    for name, label in cfg["sources"].items():
        value = ages[name]
        meaning = "No heartbeat received yet." if value is None else f"Last heartbeat {int(value)} seconds ago."
        rows.append(row(cfg, f"heartbeat/{name}", label + " heartbeat",
                        "warn" if value is None or value > cfg["window_s"] else "ok", meaning, now))
        floor_failed = bool(heartbeats.get(name, {}).get("floor_failed"))
        fresh = value is not None and value <= cfg["window_s"]
        if not fresh:
            continue  # missing evidence cannot close an existing floor alarm
        # A live app's heartbeat carries its delivery status independently of the host check timer.
        good = transition(state, f"pve-sender:floor:{name}", fresh and floor_failed,
                          {"title": prefix + label + " cannot send phone alerts", "body": "Proxmox can still reach the phone directly. Check Aico's Phone alerts and Push path status.", "severity": "warning" if test else "critical"},
                          {"title": prefix + label + " phone path recovered", "body": "The push path is working again.", "severity": "ok"}, deliver) and good
        write(state_path, state)
    if not test:
        try:
            local_rows = (local or watch.local_rows)(state.setdefault("checks", {}), now, socket.gethostname().split('.')[0])
            state["local_rows"] = local_rows
            state.pop("local_error", None)
            rows.append(row(cfg, "pve-watch", "Proxmox checks", "ok", "Local PVE checks finished.", now))
        except Exception as error:  # noqa: BLE001 -- retain previous findings if one local probe fails
            state["local_error"] = f"Local PVE checks failed ({type(error).__name__})."
            local_rows = state.get("local_rows", [])
            rows.append(row(cfg, "pve-watch", "Proxmox checks", "failed", state["local_error"], now))
        rows += local_rows
        # Proxmox owns local critical pushes while the workstation is absent, even if CT 190 is live.
        away = ages.get("workstation") is None or ages["workstation"] > cfg["window_s"]
        if now - boot >= cfg["boot_settle_s"]:
            for item in local_rows:
                key = "pve-sender:local:" + item["id"]
                active = item["state"] == "failed" and away
                # Do not close a PVE fault merely because the workstation resumed.
                if not away and item["state"] == "failed":
                    continue
                good = transition(state, key, active,
                                  {"title": "Proxmox: " + item["what"], "body": item["meaning"], "severity": "critical"},
                                  {"title": "Proxmox: " + item["what"] + " recovered", "body": item["meaning"], "severity": "ok"}, deliver) and good
                write(state_path, state)
        try:
            result = door(cfg["door_alias"]) if door else watch.door_probe(cfg["door_alias"], cfg["workstation_addr"])
            state["door_bad"] = state.get("door_bad", 0) + 1 if result in ("door", "home") else 0
            if result is not None:
                rows.append(row(cfg, "rescue-login", "Workstation rescue login", "failed" if state["door_bad"] >= cfg["door_bad_runs"] else "off" if result == "offline" else "ok" if result == "ok" else "warn", "Proxmox's rescue login works." if result == "ok" else "Workstation is offline; rescue login waits." if result == "offline" else "Proxmox could not verify the rescue login.", now))
            if result in ("door", "home", "ok"):
                # An offline machine cannot prove a previously broken rescue login recovered.
                active = state["door_bad"] >= cfg["door_bad_runs"] if result != "ok" else False
                if not active and result != "ok":
                    active = bool(state.get("alarms", {}).get("pve-sender:door"))
                good = transition(state, "pve-sender:door", active,
                                  {"title": "Workstation rescue login failed", "body": "Proxmox could not verify its rescue login on two checks. Check the workstation connection.", "severity": "critical"},
                                  {"title": "Workstation rescue login recovered", "body": "Proxmox can use its rescue login again.", "severity": "ok"}, deliver) and good
        except (OSError, subprocess.TimeoutExpired):
            rows.append(row(cfg, "rescue-login", "Workstation rescue login", "warn", "Could not finish the rescue login check.", now))
    last = state.get("last_send", {})
    rows.append(row(cfg, "pve-sender", "Proxmox phone sender", "failed" if silent or not good else "ok",
                    "Neither Aico heartbeat is current." if silent else "Watching both Aico heartbeats. " + last.get("result", "No alert needed."), now))
    state["at"] = now
    write(state_path, state)
    status = {"at": now, "silent": silent, "ages": ages, "rows": rows, "last_send": last}
    write(directory / "status.json", status)
    if publish:
        posted = subprocess.run(cfg["status_command"], input=__import__("json").dumps(rows), text=True,
                                capture_output=True, timeout=30, check=False)
        status["rows_posted"] = posted.returncode == 0
        write(directory / "status.json", status)
    return status
