"""Router drift: firmware, SSH keys, SSH server settings, port forwards, UPnP, enabled services, parental controls.

Port of the drift half of ns/checks/router.py. Every 6 h one ssh call with a root-only key that the router pins to a
read-only forced command prints one JSON line with config hashes. The first run takes a baseline silently; a change
is recorded as an event, the baseline moves, and the event stays a problem for hold_hours. A rejected key, a missing
script or a changed host key (usually a firmware upgrade) is reported and retried only every denied_retry_hours.
Router health (WAN, memory, conntrack) is OmniNull's telemetry and is not read here. State: this check's state.
"""

from __future__ import annotations

import json
from typing import Any

from host_steward.core import Ctx, Result, Signal

ID = "router-drift"
DENIED = {
    "router.source_rejected": "refused the call from this address",
    "router.host_key_changed": "has a new SSH host key",
    "router.key_missing": "no longer accepts the key",
    "router.script_missing": "lost the status script",
}


def ssh_command(cfg: dict[str, Any]) -> list[str]:
    return [
        "ssh", "-F", "/dev/null", "-i", cfg["key"], "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={cfg['known_hosts']}",
        "-o", "GlobalKnownHostsFile=/dev/null", "-o", f"ConnectTimeout={int(cfg['connect_timeout'])}",
        "-o", "LogLevel=ERROR", f"root@{cfg['addr']}", "drift",
    ]  # fmt: skip


def classify_failure(result: Result) -> str:
    err = f"{result.err}\n{result.out}".lower()
    if '"error":"source"' in result.out:
        return "router.source_rejected"
    if "host identification has changed" in err or "host key verification failed" in err:
        return "router.host_key_changed"
    if "permission denied" in err:
        return "router.key_missing"
    if result.rc == 127 or "not found" in err or "no such file" in err:
        return "router.script_missing"
    return "router.unreachable"


def parse(out: str) -> dict[str, Any] | None:
    if len(out) > 65536 or not out.strip():
        return None
    try:
        data = json.loads(out.strip().splitlines()[-1])
    except (ValueError, RecursionError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("v"), int) or "error" in data:
        return None
    return data


def snapshot(data: dict[str, Any]) -> dict[str, str] | None:
    if data.get("mode") != "drift":
        return None
    raw = data.get("services")
    services = raw if isinstance(raw, dict) else {}
    listed = ",".join(
        f"{k}:{'enabled' if v[0] else 'disabled'}/{'running' if v[1] else 'stopped'}"
        for k, v in sorted(services.items())
        if isinstance(v, list) and len(v) == 2
    )
    return {
        "firmware": f"GL {data.get('glversion')} / OpenWrt {data.get('openwrt')} / kernel {data.get('kernel')}",
        "keys": str(data.get("h_keys")),
        "dropbear": str(data.get("h_dropbear")),
        "forwards": str(data.get("h_forwards")),
        "upnp": str(data.get("h_upnp")),
        "services": f"{listed} (boot links {data.get('h_rc')})",
        "parental": f"groups {data.get('parental_groups')}",
    }


def update_baseline(snap: dict[str, str], state: dict[str, Any], now: float, keys: list[str]) -> None:
    base = state.get("baseline")
    if not isinstance(base, dict):
        state.update(baseline=snap, baselined_at=now)
        return
    changed = {k: [str(base.get(k)), snap[k]] for k in keys if k in base and k in snap and base[k] != snap[k]}
    if changed:
        state.setdefault("events", []).append({"at": now, "changed": changed})
        state["events"] = state["events"][-50:]
    state["baseline"] = {**base, **snap}


def drift_signals(state: dict[str, Any], cfg: dict[str, Any], now: float) -> list[Signal]:
    held = [e for e in state.get("events", []) if now - float(e.get("at", 0)) <= cfg["hold_hours"] * 3600]
    changed: dict[str, int] = {}
    for event in held:
        for key in event.get("changed", {}):
            changed[key] = changed.get(key, 0) + 1
    out = []
    for key in cfg["keys"]:
        if key in changed:
            cap = cfg["severity"].get(key, "warn")
            out.append(Signal("router.drift", cap, {"what": cfg["labels"].get(key, key), "n": changed[key]}, note=cap == "ok"))
    parental = state.get("parental")
    if isinstance(parental, dict) and parental and not (parental.get("module") and parental.get("enable")):
        out.append(Signal("router.parental.off", "warn"))
    return out or [Signal("router.drift.none", "ok")]


def run(ctx: Ctx) -> list[Signal]:
    cfg, state, now = ctx.cfg, ctx.state, ctx.now
    denied = state.get("denied")
    retry = cfg["denied_retry_hours"] * 3600
    if isinstance(denied, dict) and now - float(denied.get("at", 0)) < retry:
        return [Signal(str(denied["code"]), "warn", {"how": DENIED.get(str(denied["code"]), "is not answering")})]
    result = ctx.run(ssh_command(cfg), timeout=float(cfg["timeout"]))
    data = parse(result.out) if result.rc == 0 else None
    if data is None:
        code = classify_failure(result) if result.rc != 0 or '"error"' in result.out else "router.bad_output"
        if code in DENIED:
            state["denied"] = {"code": code, "at": now}
            return [Signal(code, "warn", {"how": DENIED[code]})]
        since = float(state.get("unreachable_since") or now)
        state["unreachable_since"] = since
        return [Signal(code, "warn", {"minutes": int((now - since) // 60)})]
    state.pop("denied", None)
    state.pop("unreachable_since", None)
    snap = snapshot(data)
    if snap is None:
        return [Signal("router.bad_output", "warn")]
    update_baseline(snap, state, now, cfg["keys"])
    state["parental"] = {"module": data.get("parental_module") == 1, "enable": data.get("parental_enable") == 1}
    return drift_signals(state, cfg, now)
