"""PVE host (davion-gem): thin-pool and volume-group space, failed units, SMART, pending reboot, rasdaemon.

Port of ns/checks/pve.py's storage, failed-units, smart and host sections. One ssh round trip runs read-only
shell snippets on the PVE host through the pinned hop key (collect), and the other PVE checks (ecc, thermal)
share that answer within a run. Left out: guest (VM and container) state, NIC and segment guards, honeypot and
evidence copies, the dead-man heartbeat and the executor manifest (M5b and later), apt (an info line).
Not installed on gem itself: gem has no Aico web server to take loopback rows yet (needs the fleet link).
"""

from __future__ import annotations

import json
import re
from typing import Any

from host_steward import history
from host_steward.core import Ctx, Signal

ID = "pve"
MARK = "===NS "

# Read-only snippets, run over ssh on the PVE host (shell text, not data: they are what the host executes).
SCRIPT = r"""
echo "===NS lvs"; lvs --reportformat json -o lv_name,vg_name,lv_attr,data_percent,metadata_percent,pool_lv 2>/dev/null
echo "===NS vgs"; vgs --reportformat json --units b -o vg_name,vg_size,vg_free 2>/dev/null
echo "===NS failed"; systemctl list-units --failed --no-legend --plain 2>/dev/null
echo "===NS smart"; for d in $(smartctl --scan 2>/dev/null | awk '{print $1}'); do echo "DEV $d"; smartctl -i -H -A -j "$d" 2>/dev/null | tr -d '\n'; echo; done
echo "===NS kernel"; echo "RUN $(uname -r)"; echo "UP $(cut -d. -f1 /proc/uptime)"
for k in /boot/vmlinuz-*; do [ -f "$k" ] && echo "K $(stat -c %Y "$k") ${k#/boot/vmlinuz-}"; done
[ -r /etc/kernel/proxmox-boot-pin ] && echo "PIN $(head -c 80 /etc/kernel/proxmox-boot-pin)"
[ -e /run/reboot-required ] && echo "REQ $(stat -c %Y /run/reboot-required)"
echo "===NS ecc"; journalctl _TRANSPORT=kernel --since -8d -o short-unix --no-pager 2>/dev/null | awk '
function out() { if (k != "") print k, t, (b == "" ? "-" : b), o, (a == "" ? "-" : a), u; k = "" }
NR==1 { print "FIRST", $1 }
!/\[Hardware Error\]|Fatal machine check/ { next }
/Uncorrected|Deferred error|Fatal machine check/ { out(); k = "UE"; t = $1; b = ""; o = 0; a = ""; u = 0; next }
/Corrected error/ { out(); k = "CE"; t = $1; b = ""; o = 0; a = ""; u = 0; next }
k != "" && match($0, /MC[0-9]+_STATUS\[/) { b = substr($0, RSTART + 2, RLENGTH - 10); o = ($0 ~ /STATUS\[Over/); next }
k != "" && /Error Addr:/ { a = $NF; next }
k != "" && /Unified Memory Controller/ { u = 1 }
END { out() }'
echo "===NS rasdaemon"; systemctl is-active rasdaemon 2>/dev/null
echo "===NS rasmce"; ras-mc-ctl --errors 2>/dev/null | awk '/^MCE events:/ { f = 1; next } /^$/ { f = 0 } f && /^[0-9]+ [0-9][0-9][0-9][0-9]-/' | tail -n 1000
echo "===NS hwmon"; for h in /sys/class/hwmon/hwmon*; do n=$(cat "$h/name" 2>/dev/null); for t in "$h"/temp*_input; do [ -r "$t" ] || continue; b=${t%_input}; l=$(cat "${b}_label" 2>/dev/null | tr " " _); echo "T ${n:-unknown} ${l:--} $(cat "$t" 2>/dev/null || echo x) $(cat "${b}_max" 2>/dev/null || echo 0) $(cat "${b}_crit" 2>/dev/null || echo 0)"; done; done
echo "===NS end"
"""


def split_sections(text: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {}
    current = "_preamble"
    for line in text.splitlines():
        if line.startswith(MARK):
            current = line[len(MARK) :].strip()
            sections.setdefault(current, [])
        else:
            sections.setdefault(current, []).append(line)
    return {name: "\n".join(lines) for name, lines in sections.items()}


def ssh_command(cfg: dict[str, Any]) -> list[str]:
    return [
        "ssh", "-F", "/dev/null", "-i", cfg["check_key"], "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={cfg['known_hosts']}",
        "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=10", "-T", f"root@{cfg['addr']}", "bash", "-s",
    ]  # fmt: skip


def collect(ctx: Ctx) -> tuple[dict[str, str] | None, str]:
    """The PVE host's sections, read once per run (cached for the ecc and thermal checks), or (None, why)."""
    if "pve" in ctx.cache:
        return ctx.cache["pve"]
    cfg = ctx.site["pve"]
    result = ctx.run(ssh_command(cfg), timeout=float(cfg["ssh_timeout"]), input_text=SCRIPT)
    sections = split_sections(result.out)
    answer: tuple[dict[str, str] | None, str] = (
        (sections, "")
        if "end" in sections
        else (None, (result.err.strip() or f"exit {result.rc}")[-120:])
    )
    ctx.cache["pve"] = answer
    return answer


def parse_pools(text: str) -> list[dict[str, Any]]:
    try:
        lvs = json.loads(text)["report"][0]["lv"]
    except (ValueError, KeyError, IndexError, TypeError):
        return []
    return [
        {
            "name": f"{lv['vg_name']}/{lv['lv_name']}",
            "data": float(lv.get("data_percent") or 0),
            "metadata": float(lv.get("metadata_percent") or 0),
        }
        for lv in lvs
        if lv.get("lv_attr", "").startswith("t")
    ]


def parse_vgs(text: str) -> list[dict[str, Any]]:
    try:
        vgs = json.loads(text)["report"][0]["vg"]
    except (ValueError, KeyError, IndexError, TypeError):
        return []
    return [{"name": v["vg_name"], "free": int(v["vg_free"].rstrip("B"))} for v in vgs]


def storage(sections: dict[str, str], cfg: dict[str, Any]) -> list[Signal]:
    warn, crit = cfg["thin_warn"], cfg["thin_crit"]
    pools = parse_pools(sections.get("lvs", ""))
    if not pools:
        return [Signal("pve.thin.unreadable", "warn")]
    out = []
    for kind in ("data", "metadata"):
        top = max(pools, key=lambda p: p[kind])
        pct = top[kind]
        state = "failed" if pct >= crit else "warn" if pct >= warn else "ok"
        out.append(Signal(f"pve.thin.{kind}", state, {"pool": top["name"], "pct": f"{pct:.0f}"}))
    fullest = max(max(p["data"], p["metadata"]) for p in pools)
    for vg in parse_vgs(sections.get("vgs", "")):
        gib = vg["free"] / 1024**3
        low = (
            gib < cfg["vg_free_warn_gib"] and fullest >= warn
        )  # no room only matters while a pool is filling
        out.append(
            Signal("pve.vg.free", "warn" if low else "ok", {"vg": vg["name"], "gib": f"{gib:.0f}"})
        )
    return out


def failed_units(sections: dict[str, str]) -> Signal:
    units = [line.split()[0] for line in sections.get("failed", "").splitlines() if line.split()]
    if units:
        return Signal("pve.units.failed", "warn", {"n": len(units), "units": ", ".join(units[:5])})
    return Signal("pve.units.failed", "ok")


def smart(sections: dict[str, str]) -> list[Signal]:
    out, dev = [], None
    for line in sections.get("smart", "").splitlines():
        if line.startswith("DEV "):
            dev = line[4:].strip()
        elif dev and line.strip():
            try:
                data = json.loads(line)
            except ValueError:
                out.append(Signal("pve.smart", "warn", {"dev": dev, "why": "unreadable answer"}))
                dev = None
                continue
            nvme = data.get("nvme_smart_health_information_log") or {}
            passed = (data.get("smart_status") or {}).get("passed")
            if passed is False or nvme.get("critical_warning") or nvme.get("media_errors"):
                out.append(
                    Signal(
                        "pve.smart",
                        "failed",
                        {"dev": dev, "why": "health check failed or media errors"},
                    )
                )
            else:
                out.append(Signal("pve.smart", "ok", {"dev": dev}))
            dev = None
    return out


def kernel_key(version: str) -> tuple[int, ...]:
    return tuple(int(n) for n in re.findall(r"\d+", version.split("-pve")[0])) + (
        1 if "pve" in version else 0,
    )


def reboot(sections: dict[str, str], cfg: dict[str, Any], now: float) -> Signal:
    running, up, pin, req, kernels = "", 0.0, "", 0.0, {}
    for line in sections.get("kernel", "").splitlines():
        p = line.split()
        if len(p) >= 2 and p[0] == "RUN":
            running = p[1]
        elif len(p) >= 2 and p[0] == "UP" and p[1].isdigit():
            up = float(p[1])
        elif len(p) >= 3 and p[0] == "K" and p[1].isdigit():
            kernels[p[2]] = float(p[1])
        elif len(p) >= 2 and p[0] == "PIN":
            pin = p[1]
        elif len(p) >= 2 and p[0] == "REQ" and p[1].isdigit():
            req = float(p[1])
    if not running or not kernels:
        return Signal("pve.reboot.required", "warn", {"why": "kernel list unreadable"})
    target = pin if pin in kernels else max(kernels, key=kernel_key)
    boot = now - up if up else 0.0
    if target == running and req <= boot:
        return Signal("pve.reboot.required", "ok", {"running": running})
    since = max(req if req > boot else kernels.get(target, now), boot)
    days = max(0.0, (now - since) / 86400)
    state = "warn" if days >= cfg["reboot_pending_warn_days"] else "ok"
    return Signal("pve.reboot.required", state, {"days": f"{days:.0f}"}, note=True)


def rasdaemon(sections: dict[str, str]) -> Signal:
    if sections.get("rasdaemon", "").strip().splitlines()[:1] == ["active"]:
        return Signal("pve.rasdaemon", "ok")
    return Signal("pve.rasdaemon", "warn")


def smart_readings(sections: dict[str, str]) -> list[tuple[str, float, str, str]]:
    """(metric, value, serial, kind) per disk from the SMART answers, for the trend history."""
    out, dev = [], None
    for line in sections.get("smart", "").splitlines():
        if line.startswith("DEV "):
            dev = line[4:].strip()
        elif dev and line.strip():
            try:
                data = json.loads(line)
            except ValueError:
                data = {}
            nvme = data.get("nvme_smart_health_information_log") or {}
            serial = str(data.get("serial_number") or dev)
            for key, metric, kind in (
                ("media_errors", "disk.media_errors", "counter"),
                ("percentage_used", "disk.wear_pct", "gauge"),
            ):
                if isinstance(nvme.get(key), int | float):
                    out.append((metric, float(nvme[key]), serial, kind))
            if isinstance(nvme.get("available_spare"), int | float):
                out.append(
                    ("disk.spare_used_pct", 100.0 - float(nvme["available_spare"]), serial, "gauge")
                )
            dev = None
    return out


def record_readings(ctx: Ctx, sections: dict[str, str]) -> None:
    """The pool, metadata and disk readings into the trend history (the trends check evaluates them)."""
    for pool in parse_pools(sections.get("lvs", "")):
        history.record(ctx.cache, "pool.data_pct", "pve", pool["data"], pool["name"], agg="max")
        history.record(ctx.cache, "pool.meta_pct", "pve", pool["metadata"], pool["name"], agg="max")
    for metric, value, serial, kind in smart_readings(sections):
        history.record(ctx.cache, metric, "pve", value, serial, agg="max", kind=kind)


def run(ctx: Ctx) -> list[Signal]:
    sections, why = collect(ctx)
    if sections is None:
        return [Signal("pve.unreachable", "failed", {"why": why})]
    cfg = ctx.cfg
    record_readings(ctx, sections)
    return [
        *storage(sections, cfg),
        failed_units(sections),
        *smart(sections),
        reboot(sections, cfg, ctx.now),
        rasdaemon(sections),
    ]
