"""PVE guests: run state, thin-pool discard, guest agents and filesystems, boot guests that are down, segment guards.

Port of the guest sections of ns/checks/pve.py (vms, agents, nics, the segment guard of "failed") and the guest
metadata read of ns/checks/registry.py. One read-only ssh round trip over the same pinned hop as the pve check
(collect), shared with the assets check through ctx.cache. Of the lab flow check on the segment (ns/checks/labnet.py)
only its breach rule is kept (lab_flows): a flow the segment filter let through to or from a private address that the
guard's `allow` list doesn't name. Its volume and novelty hunt, honeypot and evidence copies, the dead-man and executor
sections (M5b) are left out.

A guest set to start at boot that is not running is "parked" when its latest PVE task is a stop that succeeded since
PVE booted (someone turned it off on purpose; it starts again at the next boot): a note, not a fault.
"""

from __future__ import annotations

import ipaddress
import logging
import re
from typing import Any

from host_steward import acts, assets, core, history
from host_steward.checks.pve import split_sections, ssh_command
from host_steward.core import Ctx, Signal

log = logging.getLogger("host-steward")

ID = "guests"

_VM_LOOP = (
    'for c in /etc/pve/qemu-server/*.conf; do [ -f "$c" ] || continue; id=${c##*/}; id=${id%.conf}; st=stopped; '
    'p=/var/run/qemu-server/$id.pid; [ -r "$p" ] && kill -0 "$(cat "$p")" 2>/dev/null && st=running; '
)
# get-fsinfo's pretty JSON has sorted keys (mountpoint < total-bytes < type < used-bytes), so one line per filesystem
# is printed at used-bytes: "FS <vmid> <type> <used> <total> <mountpoint>". No single quotes (it sits inside them).
_FS_AWK = (
    r'/^ *"mountpoint" :/{m=$0;sub(/^ *"mountpoint" : "/,"",m);sub(/",?$/,"",m)} /^ *"total-bytes" :/{t=$3+0} '
    r'/^ *"type" :/{y=$3;gsub(/[",]/,"",y)} /^ *"used-bytes" :/{print "FS",id,y,$3+0,t,m;m="";t=0;y=""}'
)

# Read-only snippets run over ssh on the PVE host (shell text, not data: they are what the host executes).
SCRIPT = (
    "export LC_ALL=C\n"
    'echo "===NS vms"; ' + _VM_LOOP +
    'echo "VM $id $st"; awk \'/^\\[/{if($0=="[PENDING]"){p=1;next} exit} '
    '/^(agent|name|onboot|template|scsi[0-9]+|virtio[0-9]+|sata[0-9]+|ide[0-9]+):/{print (p?"P ":"") $0}\' "$c"; done; '
    # containers: name from config, state from lxc-info (C, fast; pct is perl)
    'for c in /etc/pve/lxc/*.conf; do [ -f "$c" ] || continue; id=${c##*/}; id=${id%.conf}; '
    'st=$(lxc-info -n "$id" -s 2>/dev/null | awk \'{print tolower($2)}\'); '
    'ob=$(sed -n \'/^\\[/q; s/^onboot: *//p\' "$c"); '
    'echo "CT $id ${st:-unknown} ob=${ob:-0} $(sed -n \'/^\\[/q; s/^hostname: *//p\' "$c")"; done; '
    # each guest's latest start/stop task (UPID:node:pid:pstart:STARTHEX:TYPE:ID:USER: ...) and the host's boot time:
    # a guest someone stopped since boot is parked, not down
    'echo "BOOT $(date -d "$(uptime -s)" +%s)"; h=$(printf %08X $(($(date +%s) - 172800))); '
    'cat /var/log/pve/tasks/index /var/log/pve/tasks/active 2>/dev/null | awk -F: -v h="$h" \'$6 ~ /^(qm|vz)(start|stop|shutdown)$/ '
    '{r=$7 " " $6 " " $5 " " $8 " " ($0 ~ / OK$/ ? "ok" : "fail"); if ($5 >= h) print "HIST " r; '
    'if ($5 > t[$7]) {t[$7]=$5; l[$7]="TASK " r}} '
    'END {for (i in l) print l[i]}\'\n'
    'echo "===NS agents"; ' + _VM_LOOP +
    '[ "$st" = running ] && sed \'/^\\[/q\' "$c" | grep -qE \'^agent: *(1|enabled=1)\' && '
    '{ if timeout 8 qm agent "$id" ping >/dev/null 2>&1; then echo "AGENT $id ok"; '
    'timeout 15 qm guest cmd "$id" get-fsinfo 2>/dev/null | awk -v id="$id" \'' + _FS_AWK + '\'; '
    'else echo "AGENT $id down"; fi; } & '
    'done; wait\n'
    # every guest's NICs and run state, tags, pools: /etc/pve and pid files only; lxc-info for containers
    'echo "===NS nics"; for c in /etc/pve/qemu-server/*.conf /etc/pve/lxc/*.conf; do [ -f "$c" ] || continue; '
    'id=${c##*/}; id=${id%.conf}; st=stopped; case "$c" in */lxc/*) t=ct; '
    '[ "$(lxc-info -n "$id" -s 2>/dev/null | awk \'{print $2}\')" = RUNNING ] && st=running;; '
    '*) t=vm; p=/var/run/qemu-server/$id.pid; [ -r "$p" ] && kill -0 "$(cat "$p")" 2>/dev/null && st=running;; esac; '
    'echo "G $id $t $st"; sed -n \'/^\\[/q; /^\\(net[0-9][0-9]*\\|tags\\|template\\):/p\' "$c"; done\n'
    'echo "===NS pools"; grep "^pool:" /etc/pve/user.cfg 2>/dev/null\n'
    # who started each guest: PVE's task log (user per qmstart/vzstart; API tokens carry "!") and the web/API access log
    'echo "===NS starts"; grep -hE ":(qmstart|vzstart):[0-9]+:" /var/log/pve/tasks/index /var/log/pve/tasks/active '
    '2>/dev/null | tail -n 400\n'
    'echo "===NS webstarts"; grep -hE "\\"POST /api2/json/nodes/[^/ ]+/(qemu|lxc)/[0-9]+/status/start " '
    '/var/log/pveproxy/access.log /var/log/pveproxy/access.log.1 2>/dev/null | tail -n 200\n'
    # network segment guards: which bridges and nftables tables exist right now
    'echo "===NS netiso"; ip -o link show type bridge 2>/dev/null | awk -F\': \' \'{sub(/@.*/,"",$2); print "BR", $2}\'; '
    'nft list tables 2>/dev/null | awk \'{print "NFT", $2, $3}\'\n'
    'echo "===NS end"\n'
)  # fmt: skip

GUEST_FS_SKIP = {
    "vfat",
    "tmpfs",
    "devtmpfs",
    "squashfs",
    "iso9660",
    "udf",
    "cdfs",
    "overlay",
    "ramfs",
}
_UNSAFE = re.compile(r"[^\x20-\x7e]")  # guest-controlled text: printable ASCII only
_NAME = re.compile(r"[A-Za-z0-9_.-]{1,32}")


def collect(ctx: Ctx) -> tuple[dict[str, str] | None, str]:
    """The PVE host's guest sections, read once per run (the assets check shares them), or (None, why)."""
    if "guests" in ctx.cache:
        return ctx.cache["guests"]
    cfg = ctx.site["pve"]
    script = SCRIPT.replace('echo "===NS end"', flows_snippet(ctx.site.get("segment_guards", [])) + 'echo "===NS end"')
    result = ctx.run(ssh_command(cfg), timeout=float(cfg["ssh_timeout"]), input_text=script)
    sections = split_sections(result.out)
    answer: tuple[dict[str, str] | None, str] = (
        (sections, "")
        if "end" in sections
        else (None, (result.err.strip() or f"exit {result.rc}")[-120:])
    )
    ctx.cache["guests"] = answer
    return answer


def parse_vms(text: str) -> list[dict[str, Any]]:
    vms: list[dict[str, Any]] = []
    for line in text.splitlines():
        if line.startswith("VM "):
            _, vmid, status = line.split()[:3]
            vms.append({"vmid": vmid, "status": status, "disks": []})
        elif line.startswith("CT ") or not vms:
            continue
        elif line.startswith("name: "):
            vms[-1]["name"] = line[6:].strip()
        elif line.startswith("template: "):
            vms[-1]["template"] = line[10:].strip() == "1"
        elif line.startswith("onboot: "):
            vms[-1]["onboot"] = line[8:].strip() == "1"
        else:
            pending = line.startswith("P ")
            m = re.match(r"^(scsi|virtio|sata|ide)(\d+): (.*)$", line[2:] if pending else line)
            if m and pending:  # [PENDING] value applies at the next VM restart
                for d in vms[-1]["disks"]:
                    if d["slot"] == f"{m.group(1)}{m.group(2)}":
                        d["pending_discard"] = "discard=on" in m.group(3) and not d["discard"]
            elif m and "media=cdrom" not in m.group(3) and "cloudinit" not in m.group(3):
                opts = m.group(3)
                size = re.search(r"size=(\d+)([MGT])", opts)
                gib = (
                    int(size.group(1)) / {"M": 1024, "G": 1, "T": 1 / 1024}[size.group(2)]
                    if size
                    else 0.0
                )
                vms[-1]["disks"].append(
                    {
                        "slot": f"{m.group(1)}{m.group(2)}",
                        "storage": opts.split(":", 1)[0],
                        "discard": "discard=on" in opts,
                        "size_gib": round(gib, 2),
                    }
                )
    return vms


def parse_guests(text: str) -> list[dict[str, Any]]:
    """Every VM and container: vmid, type, name, status (templates flagged), in vmid order."""
    out: list[dict[str, Any]] = []
    for v in parse_vms(text):
        out.append(
            {
                "vmid": v["vmid"], "type": "vm", "name": v.get("name", ""), "status": v["status"],
                "template": v.get("template", False), "onboot": v.get("onboot", False),
            }
        )  # fmt: skip
    for line in text.splitlines():
        if line.startswith("CT "):
            parts = line.split(maxsplit=3)
            if len(parts) < 3:
                continue
            onboot = False
            if len(parts) > 3 and parts[3].startswith("ob="):  # 'CT id state ob=0|1 hostname'
                flag, _, rest = parts[3].partition(" ")
                onboot, parts[3] = flag == "ob=1", rest
            out.append(
                {
                    "vmid": parts[1], "type": "ct", "name": parts[3] if len(parts) > 3 else "", "status": parts[2],
                    "template": False, "onboot": onboot,
                }
            )  # fmt: skip
    return sorted(out, key=lambda g: int(g["vmid"]) if g["vmid"].isdigit() else 0)


def parse_guest_tasks(text: str) -> tuple[dict[str, dict[str, Any]], float | None]:
    """'TASK <vmid> <qm|vz><start|stop|shutdown> <starthex> <user> <ok|fail>' and 'BOOT <epoch>' lines: each guest's
    latest start/stop task, and when the PVE host booted (None when not reported)."""
    tasks: dict[str, dict[str, Any]] = {}
    boot = None
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == "BOOT" and parts[1].isdigit():
            boot = float(parts[1])
        elif len(parts) == 6 and parts[0] == "TASK":
            try:
                ts = float(int(parts[3], 16))
            except ValueError:
                continue
            tasks[parts[1]] = {
                "action": parts[2][2:],
                "ts": ts,
                "user": parts[4],
                "ok": parts[5] == "ok",
            }
    return tasks, boot


def parse_guest_history(text: str) -> dict[str, list[dict[str, Any]]]:
    """'HIST <vmid> <qm|vz><start|stop|shutdown> <starthex> <user> <ok|fail>' lines: each guest's start/stop tasks of
    the last two days, oldest first (a task in both the index and the active list once)."""
    seen: dict[str, dict[tuple[float, str], dict[str, Any]]] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 6 or parts[0] != "HIST":
            continue
        try:
            ts = float(int(parts[3], 16))
        except ValueError:
            continue
        action = parts[2][2:]
        seen.setdefault(parts[1], {})[(ts, action)] = {
            "action": action,
            "ts": ts,
            "user": parts[4],
            "ok": parts[5] == "ok",
        }
    return {vmid: [t for _, t in sorted(rows.items())] for vmid, rows in seen.items()}


def save_detail(ctx: Ctx, text: str) -> None:
    """The guests and their start/stop history for the probes check (which guests were off on purpose), beside the
    state file. Never fails the check."""
    name = ctx.cfg.get("guests_file")
    if not name:
        return
    guests = parse_guests(text)
    tasks, _ = parse_guest_tasks(text)
    detail = {
        "seen": ctx.now,
        "details": {
            "guests": [
                {k: g.get(k) for k in ("vmid", "name", "status", "type", "template")}
                for g in guests
            ],
            "tasks": parse_guest_history(text),
            "last": tasks,
        },
    }
    try:
        acts.write_json(core.STATE_PATH.parent / str(name), detail)
    except OSError as error:
        log.warning("guest detail not saved: %s", error)


def parse_agents(text: str) -> dict[str, str]:
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[0] == "AGENT":
            out[parts[1]] = parts[2]
    return out


def parse_guest_fs(text: str) -> dict[str, list[dict[str, Any]]]:
    """'FS <vmid> <type> <used> <total> <mount>' lines -> real filesystems of at least 1 GiB per VM (at most 8). The
    guest writes this data: mount names and types are reduced to printable ASCII."""
    out: dict[str, list[dict[str, Any]]] = {}
    for line in text.splitlines():
        parts = line.split(None, 5)
        if len(parts) != 6 or parts[0] != "FS" or not parts[1].isdigit():
            continue
        try:
            used, total = int(parts[3]), int(parts[4])
        except ValueError:
            continue
        if parts[2].lower() in GUEST_FS_SKIP or total < 1 << 30 or used < 0 or used > total:
            continue
        rows = out.setdefault(parts[1], [])
        if len(rows) < 8:  # a guest controls this list
            rows.append(
                {
                    "type": _UNSAFE.sub("?", parts[2])[:16],
                    "used": used,
                    "total": total,
                    "mount": _UNSAFE.sub("?", parts[5])[:80],
                }
            )
    return out


def parse_net(slot: str, val: str) -> dict[str, Any]:
    """One PVE netN: config value -> {slot, bridge, tag, firewall[, trunks]}."""
    kv = dict(p.split("=", 1) for p in val.split(",") if "=" in p)
    nic: dict[str, Any] = {
        "slot": slot, "bridge": kv.get("bridge", ""), "tag": kv.get("tag", ""), "firewall": kv.get("firewall") == "1",
    }  # fmt: skip
    if kv.get("trunks"):
        nic["trunks"] = kv["trunks"]
    return nic


def parse_nics(text: str, pools_text: str = "") -> dict[str, dict[str, Any]]:
    """'G <vmid> <vm|ct> <running|stopped>' then its netN/tags/template lines -> vmid -> {type, status, nets, tags,
    pools, template}; pool lines ('pool:<name>:<comment>:<vmids>:...') add the pools."""
    out: dict[str, dict[str, Any]] = {}
    cur: dict[str, Any] | None = None
    for line in text.splitlines():
        parts = line.split()
        if line.startswith("G ") and len(parts) == 4 and parts[1].isdigit():
            cur = out[parts[1]] = {
                "type": parts[2],
                "status": parts[3],
                "nets": [],
                "tags": [],
                "pools": [],
                "template": False,
            }
        elif cur is not None and ":" in line:
            key, _, val = line.partition(":")
            val = val.strip()
            if key == "tags":
                cur["tags"] = [
                    t.lower() for t in val.replace(",", ";").replace(" ", ";").split(";") if t
                ][:20]
            elif key == "template":
                cur["template"] = val == "1"
            elif re.fullmatch(r"net\d+", key):
                cur["nets"].append(parse_net(key, val))
    for line in pools_text.splitlines():
        parts = line.split(":")
        if len(parts) >= 4 and parts[0] == "pool":  # pool:<id>:<comment>:<guests>:<storages>
            for vmid in parts[3].split(","):
                if vmid.strip() in out:
                    out[vmid.strip()]["pools"].append(parts[1].lower())
    return out


def parse_netiso(text: str) -> tuple[set[str], set[str]]:
    """'BR name' / 'NFT family table' lines -> (bridges, 'family table' names)."""
    bridges, tables = set(), set()
    for line in text.splitlines():
        p = line.split()
        if len(p) == 2 and p[0] == "BR" and _NAME.fullmatch(p[1]):
            bridges.add(p[1])
        elif len(p) == 3 and p[0] == "NFT" and _NAME.fullmatch(p[1]) and _NAME.fullmatch(p[2]):
            tables.add(f"{p[1]} {p[2]}")
    return bridges, tables


def segments(text: str, guards: list[dict[str, Any]]) -> list[Signal]:
    """An isolated segment's bridge must never be up without its filter table (a failed boot or a flush leaves the
    segment routed to the LAN)."""
    bridges, tables = parse_netiso(text)
    out = []
    for g in guards:
        bridge, table = str(g.get("bridge", "")), " ".join(str(g.get("nft_table", "")).split())
        if not _NAME.fullmatch(bridge) or len(table.split()) != 2:
            continue
        fields = {"bridge": bridge, "table": table}
        if bridge not in bridges:
            out.append(Signal("guests.segment", "ok", {**fields, "how": "absent"}, note=True))
        elif table not in tables:
            out.append(Signal("guests.segment", "failed", {**fields, "how": "open"}))
        else:
            out.append(Signal("guests.segment", "ok", {**fields, "how": "guarded"}))
    return out


# Lab flows (the breach rule of ns/checks/labnet.py). Conntrack entries without zone= are zone 0: confirmed only after
# the segment's forward filter accepted them, so they are flows that really left or entered the segment. awk prints
# one line per distinct (proto, src, dst, dport) touching the bridge's subnet: "FL <bridge> <proto> <src> <dst> <dport>".
_FLOW_AWK = (
    'function n(s,  a) { split(s, a, "."); return ((a[1] * 256 + a[2]) * 256 + a[3]) * 256 + a[4] } '
    'BEGIN { split(cidr, c, "/"); sz = 2 ^ (32 - c[2]); base = int(n(c[1]) / sz) } '
    '/zone=/ { next } '
    '{ s = ""; d = ""; p = "-"; for (i = 2; i <= NF; i++) { f = $i; '
    'if (f ~ /^src=/) { if (s == "") s = substr(f, 5) } else if (f ~ /^dst=/) { if (d == "") d = substr(f, 5) } '
    'else if (f ~ /^dport=/) { if (p == "-") p = substr(f, 7) } } '
    'if (s == "" || d == "") next; if (int(n(s) / sz) != base && int(n(d) / sz) != base) next; '
    'k = br " " $1 " " s " " d " " p; if (!(k in seen)) { seen[k] = 1; if (m++ < 2000) print "FL " k } }'
)
# Never egress: multicast and the limited broadcast are the host receiving guests' chatter, not a breach.
_LOCAL_ONLY = (ipaddress.ip_network("224.0.0.0/4"), ipaddress.ip_network("255.255.255.255/32"))
_PRIVATE = tuple(
    ipaddress.ip_network(n)
    for n in ("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
              "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4")
)


def flows_snippet(guards: Any) -> str:
    """Read-only shell for the PVE hop: per guarded bridge its subnet and its zone-0 conntrack flows."""
    parts = []
    for g in guards if isinstance(guards, list) else []:
        bridge = str(g.get("bridge", "")) if isinstance(g, dict) else ""
        if not _NAME.fullmatch(bridge):
            continue
        parts.append(
            f'net=$(ip -4 -o addr show dev {bridge} 2>/dev/null | awk \'{{print $4; exit}}\'); echo "NET {bridge} $net"; '
            f'case "$net" in *.*/*) conntrack -L -f ipv4 2>/dev/null | awk -v cidr="$net" -v br={bridge} \'{_FLOW_AWK}\';; esac\n'
        )
    return ('echo "===NS labflows"\n' + "".join(parts)) if parts else ""


def _ip(text: str) -> ipaddress.IPv4Address | None:
    try:
        return ipaddress.IPv4Address(text)
    except ValueError:
        return None


def _allowed(rule: Any, proto: str, src: str, dst: str, dport: str) -> bool:
    """A guard `allow` entry: every field it names matches (from, to: address lists; proto; port)."""
    if not isinstance(rule, dict):
        return False
    return (
        ("from" not in rule or src in [str(a) for a in rule["from"]])
        and ("to" not in rule or dst in [str(a) for a in rule["to"]])
        and ("proto" not in rule or proto == str(rule["proto"]))
        and ("port" not in rule or dport == str(rule["port"]))
    )


def lab_flows(text: str, guards: Any) -> list[Signal]:
    """A zone-0 flow from a guarded segment to a private address outside it, or into it from outside, that the guard's
    `allow` list doesn't name: the filter should make it impossible, so it fails (it pages the owner)."""
    nets: dict[str, ipaddress.IPv4Network] = {}
    flows: dict[str, list[tuple[str, str, str, str]]] = {}
    for line in text.splitlines():
        p = line.split()
        if len(p) == 3 and p[0] == "NET":
            try:
                nets[p[1]] = ipaddress.ip_interface(p[2]).network  # type: ignore[assignment]
            except ValueError:
                continue
        elif len(p) == 6 and p[0] == "FL":
            flows.setdefault(p[1], []).append((p[2], p[3], p[4], p[5]))
    out = []
    for g in guards if isinstance(guards, list) else []:
        bridge = str(g.get("bridge", "")) if isinstance(g, dict) else ""
        net = nets.get(bridge)
        if net is None:
            continue
        allow = g.get("allow") or []
        bad = []
        for proto, src, dst, dport in flows.get(bridge, []):
            s, d = _ip(src), _ip(dst)
            if s is None or d is None:
                continue
            leaving = s in net and d not in net and any(d in n for n in _PRIVATE) and not any(d in n for n in _LOCAL_ONLY)
            entering = d in net and s not in net
            if (leaving or entering) and not any(_allowed(r, proto, src, dst, dport) for r in allow):
                bad.append(f"{src} -> {dst}:{dport}/{proto}")
        fields = {"bridge": bridge, "n": str(len(bad)), "first": bad[0] if bad else "", "flows": ", ".join(bad[:20])}
        out.append(Signal("guests.labflow", "failed" if bad else "ok", fields, note=not bad))
    return out


def discard_signal(vms: list[dict[str, Any]], pool_storage: str) -> Signal:
    off = [
        {"vmid": v["vmid"], "slot": d["slot"], "pending": bool(d.get("pending_discard"))}
        for v in vms for d in v["disks"]
        if d["storage"] == pool_storage and not d["discard"] and d["size_gib"] >= 1
    ]  # fmt: skip
    todo = [d for d in off if not d["pending"]]
    where = ", ".join(f"VM {d['vmid']} {d['slot']}" for d in todo)
    pending = sum(1 for d in off if d["pending"])
    return Signal(
        "guests.discard_off", "warn" if off else "ok",
        {"n": len(todo), "where": where, "pending": f"; {pending} set, applies at the next VM restart" if pending else ""},
    )  # fmt: skip


def who(user: str) -> str:
    """root@pam -> root, summitflow@pve!automation -> summitflow automation."""
    name, _, token = user.partition("!")
    return name.split("@")[0] + (f" {token}" if token else "")


def guest_label(g: dict[str, Any]) -> str:
    return f"{g['name'] or g['type'].upper()} ({g['vmid']})"


def run_state(text: str) -> list[Signal]:
    guests = parse_guests(text)
    if not guests:
        return [Signal("guests.none", "warn")]
    live = [g for g in guests if not g["template"]]
    running = sum(g["status"] == "running" for g in live)
    out = [
        Signal(
            "guests.running",
            "ok",
            {"running": running, "total": len(live), "templates": len(guests) - len(live)},
        )
    ]
    tasks, boot = parse_guest_tasks(text)
    stopped = [g for g in live if g.get("onboot") and g["status"] != "running"]
    parked = [
        g for g in stopped
        if (t := tasks.get(g["vmid"])) and t["action"] in ("stop", "shutdown") and t["ok"] and boot is not None and t["ts"] >= boot
    ]  # fmt: skip
    down = [g for g in stopped if g not in parked]
    held = ", ".join(f"{guest_label(g)} by {who(tasks[g['vmid']]['user'])}" for g in parked)
    if down:
        names = ", ".join(guest_label(g) for g in down[:6]) + (
            f" (+{len(down) - 6} more)" if len(down) > 6 else ""
        )
        out.append(
            Signal(
                "guests.stopped",
                "warn",
                {
                    "n": len(down),
                    "names": names,
                    "held": f"; stopped on purpose: {held}" if held else "",
                },
            )
        )
    elif parked:
        out.append(
            Signal(
                "guests.stopped",
                "ok",
                {"n": 0, "names": "", "held": held, "parked": len(parked)},
                note=True,
            )
        )
    else:
        out.append(Signal("guests.stopped", "ok", {"n": 0}))
    return out


def agents_and_disks(
    vm_text: str,
    agent_text: str,
    cfg: dict[str, Any],
    cache: dict[str, Any],
    asset_for: Any,
    now: float | None = None,
) -> list[Signal]:
    down = sorted(k for k, v in parse_agents(agent_text).items() if v == "down")
    out = [
        Signal(
            "guests.agent_down",
            "warn" if down else "ok",
            {"n": len(down), "vmids": ", ".join(down)},
        )
    ]
    names = {str(g["vmid"]): g.get("name") or "" for g in parse_guests(vm_text)}
    for vmid, filesystems in sorted(parse_guest_fs(agent_text).items()):
        worst = max(filesystems, key=lambda x: x["used"] / x["total"])
        pct = round(worst["used"] * 100 / worst["total"], 1)
        free = round((worst["total"] - worst["used"]) / (1 << 30), 1)
        history.record(cache, "guest.disk_used_pct", "pve", pct, vmid, now, agg="max")
        state = (
            "failed"
            if pct >= cfg["guest_disk_crit_pct"]
            else "warn"
            if pct >= cfg["guest_disk_warn_pct"]
            else "ok"
        )
        name = names.get(vmid) or f"VM {vmid}"
        sig = Signal(
            "guests.disk",
            state,
            {
                "name": name,
                "vmid": vmid,
                "mount": worst["mount"],
                "pct": f"{pct:.0f}",
                "free": f"{free:.0f}",
            },
        )
        out.append(asset_for(vmid, sig))
    return out


def run(ctx: Ctx) -> list[Signal]:
    sections, why = collect(ctx)
    if sections is None:
        return [Signal("guests.unreachable", "warn", {"why": why})]
    reg, iso = assets.registry_for_run(
        assets.load_state(), assets.load_file().get("tiers", {}).get("tag_tiers", {})
    )

    def tiered(vmid: str, sig: Signal) -> Signal:
        a = reg.by_vmid(vmid)
        return sig if a is None else assets.tier_signal(sig, "health", a, iso.get(a.id, False))

    text = sections.get("vms", "")
    save_detail(ctx, text)
    out = [
        discard_signal(parse_vms(text), ctx.cfg["pool_storage"]),
        *run_state(text),
        *agents_and_disks(text, sections.get("agents", ""), ctx.cfg, ctx.cache, tiered, ctx.now),
        *segments(sections.get("netiso", ""), ctx.site.get("segment_guards", [])),
        *lab_flows(sections.get("labflows", ""), ctx.site.get("segment_guards", [])),
    ]
    return out
