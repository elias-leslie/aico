"""The asset registry against what PVE shows: guests nobody registered, parked machines that are running, lab guests
on the LAN.

Port of ns/checks/registry.py without the OmniNull side (endpoint presence and isolation: the hub's ingest is gone).
Nothing here changes a tier: mismatches and suggestions are notes, and the owner edits data/assets.toml. Guests
come from the guests check's ssh read (shared through ctx.cache). State (assets.json): the first-seen tier of each
discovered guest, last tiers, isolation verdicts, the discovered guests the tier step uses, and when a parked machine
first ran unexplained.

A parked machine that is running is explained by a lab-use declaration (an agent session says it uses it) or by being
started with an automation token; started in the PVE web UI it is a warning with no clock; otherwise it is a warning
and after the data file's hours (sooner when it holds data) a failure for a machine with data.
A lab guest running with a NIC on a LAN bridge is a breach (failed), whatever its declared isolation.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from host_steward import assets
from host_steward.checks import guests as g
from host_steward.core import Ctx, Signal

ID = "assets"
_UPID = re.compile(
    r"UPID:[^:\s]+:[0-9A-F]+:[0-9A-F]+:([0-9A-F]{8}):(qmstart|vzstart):([0-9]{3,9}):([A-Za-z0-9._@!-]{1,64}):"
)
_WEB = re.compile(
    r"(\S+) - ([A-Za-z0-9._@!-]{1,64}) \[(\d{2}/\d{2}/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4})\] "
    r'"POST /api2/json/nodes/[^/ ]+/(?:qemu|lxc)/([0-9]{3,9})/status/start [^"]*" (\d{3})'
)
_IP = re.compile(r"(?:::ffff:)?([0-9a-fA-F:.]{2,45})")


def parse_starts(text: str) -> dict[str, dict[str, Any]]:
    """vmid -> the latest PVE start task {at, user} (task log lines, oldest first)."""
    out: dict[str, dict[str, Any]] = {}
    for line in text.splitlines():
        m = _UPID.search(line)
        if m and "already running" not in line:
            at = int(m.group(1), 16)
            if at >= float((out.get(m.group(3)) or {}).get("at", 0)):
                out[m.group(3)] = {"at": at, "user": m.group(4)}
    return out


def parse_webstarts(text: str) -> list[dict[str, Any]]:
    """Accepted start requests through the PVE web UI or API: [{vmid, at, user, ip}]."""
    out = []
    for line in text.splitlines():
        m = _WEB.match(line.strip())
        if not m or m.group(5) != "200":
            continue
        try:
            at = datetime.strptime(m.group(3), "%d/%m/%Y:%H:%M:%S %z").timestamp()
        except ValueError:
            continue
        ip = _IP.fullmatch(m.group(1))
        out.append(
            {"vmid": m.group(4), "at": at, "user": m.group(2), "ip": ip.group(1) if ip else "?"}
        )
    return out[-200:]


def attribution(vmid: Any, starts: dict[str, Any], web: list[dict[str, Any]]) -> dict[str, Any]:
    """How a guest's latest start happened: token (an API token, i.e. automation), web (the PVE web UI or API, with
    user and address), shell (qm/pct on the PVE host) or unknown (no start record)."""
    s = starts.get(str(vmid)) if vmid is not None else None
    if not isinstance(s, dict):
        return {"kind": "unknown"}
    at, user = float(s.get("at") or 0), str(s.get("user") or "?")
    if "!" in user:
        return {"kind": "token", "at": at, "user": user}
    hits = [
        w
        for w in web
        if w.get("vmid") == str(vmid) and at - 120 <= float(w.get("at") or 0) <= at + 60
    ]
    if hits:
        return {
            "kind": "web",
            "at": at,
            "user": str(hits[-1].get("user") or user),
            "ip": str(hits[-1].get("ip") or "?"),
        }
    return {"kind": "shell", "at": at, "user": user}


def hm(ts: float) -> str:
    return datetime.fromtimestamp(ts).astimezone().strftime("%a %H:%M")


def parked_signal(
    a: assets.Asset,
    att: dict[str, Any],
    claim: dict[str, Any] | None,
    seen: dict[str, Any],
    now: float,
    cfg: dict[str, Any],
) -> Signal:
    """The signal for a running parked asset. `seen` holds when each ran unexplained since (updated in place)."""
    held = " and holds data" if a.data else ""
    fields = {"asset": a.label(), "held": held}
    if claim:
        seen.pop(a.id, None)
        return Signal(
            "assets.parked_in_use",
            "ok",
            {**fields, "by": claim["by"], "reason": claim["reason"], "until": hm(claim["until"])},
            note=True,
        )
    if att["kind"] == "token":
        seen.pop(a.id, None)
        return Signal(
            "assets.parked_token",
            "ok",
            {**fields, "at": hm(float(att["at"])), "user": att["user"]},
            note=True,
        )
    if att["kind"] == "web":  # started by hand in the web UI: the person who did it knows; no clock
        seen.pop(a.id, None)
        since = now
    else:
        prev = seen.get(a.id)
        since = float(prev) if isinstance(prev, int | float) and not isinstance(prev, bool) else now
        seen[a.id] = since
    started = hm(float(att.get("at") or now))
    how = {
        "web": f"started {started} in the Proxmox web UI by {att.get('user')} from {att.get('ip')}",
        "shell": f"started {started} as {att.get('user')} from a shell on PVE, and no agent session declared it",
        "unknown": "no start record, and no agent session declared it",
    }[att["kind"]]  # fmt: skip
    limit = 3600 * float(cfg["unexplained_data_hours"] if a.data else cfg["unexplained_hours"])
    late = att["kind"] != "web" and now - since >= limit
    return Signal(
        "assets.parked_running", "failed" if late and a.data else "warn", {**fields, "how": how}
    )


def run(ctx: Ctx) -> list[Signal]:
    sections, why = g.collect(ctx)
    cfg, site = ctx.cfg, ctx.site
    tag_tiers = assets.load_file().get("tiers", {}).get("tag_tiers", {})
    reg = assets.load()
    state = ctx.state
    if not state:  # the first run starts from assets.json, copied from Nightshift's
        state.update(assets.load_state())
    out: list[Signal] = []
    if reg.problems:
        out.append(
            Signal("assets.config", "warn", {"n": len(reg.problems), "first": reg.problems[0]})
        )
    if sections is None:
        out.append(Signal("assets.pve_meta_unavailable", "ok", {"why": why}, note=True))
        return out
    fresh = g.parse_nics(sections.get("nics", ""), sections.get("pools", ""))
    guests = [
        {
            **guest,
            "tags": fresh.get(str(guest["vmid"]), {}).get("tags", []),
            "pools": fresh.get(str(guest["vmid"]), {}).get("pools", []),
        }
        for guest in g.parse_guests(sections.get("vms", ""))
    ]
    added = assets.discover(reg, guests, state, ctx.now, tag_tiers)
    lan = list(site["assets"]["lan_bridges"])
    vlans = assets.lab_vlans(site["assets"]["lab_vlans"])
    nets = {vmid: m["nets"] for vmid, m in fresh.items()}
    status = {str(guest["vmid"]): str(guest["status"]) for guest in guests}
    status.update(
        {vmid: m["status"] for vmid, m in fresh.items() if m["status"] in ("running", "stopped")}
    )
    iso = {a.id: assets.isolated_verified(a, nets, lan, vlans) for a in reg.assets.values()}

    claims = assets.lab_claims(list(site["assets"]["lab_use_files"]), ctx.now)
    starts, web = (
        parse_starts(sections.get("starts", "")),
        parse_webstarts(sections.get("webstarts", "")),
    )
    unexplained: dict[str, Any] = dict(state.get("parked_unexplained") or {})
    running = []
    for a in reg.assets.values():
        if a.presence != "parked" or a.kind == "template" or a.vmid is None or not status:
            continue
        if status.get(str(a.vmid)) == "running":
            running.append(a)
            claim = claims.get(a.id) or claims.get(str(a.vmid))
            out.append(
                parked_signal(a, attribution(a.vmid, starts, web), claim, unexplained, ctx.now, cfg)
            )
    state["parked_unexplained"] = {
        k: v for k, v in unexplained.items() if k in {a.id for a in running}
    }

    suggestions = []
    for guest in guests:
        a = reg.by_vmid(guest.get("vmid"))
        tier = assets.tag_tier(
            list(guest.get("tags") or []), list(guest.get("pools") or []), tag_tiers
        )
        if a is not None and a.source != "discovered" and tier and tier != a.tier:
            suggestions.append(f"{a.label()}: PVE marks {tier}, registry {a.tier}")
    if suggestions:
        out.append(
            Signal(
                "assets.suggestion",
                "ok",
                {"n": len(suggestions), "first": suggestions[0]},
                note=True,
            )
        )
    last = state.get("tiers") or {}
    lowered = sorted(
        f"{aid} {last[aid]} -> {a.tier}"
        for aid, a in reg.assets.items()
        if last.get(aid) in assets.TIERS and assets.TIER_RANK[a.tier] < assets.TIER_RANK[last[aid]]
    )
    if lowered:
        out.append(
            Signal("assets.tier_lowered", "ok", {"n": len(lowered), "first": lowered[0]}, note=True)
        )
    if added:
        names = ", ".join(f"{aid} ({reg.assets[aid].tier})" for aid in added[:6])
        out.append(Signal("assets.discovered", "ok", {"n": len(added), "names": names}, note=True))

    for a in sorted(
        (a for a in reg.assets.values() if a.tier == "lab" and a.kind != "template"),
        key=lambda a: a.id,
    ):
        on_lan = [n["slot"] for n in nets.get(str(a.vmid), []) if assets.on_lan(n, lan, vlans)]
        why_not = iso[a.id][1]
        if on_lan and status.get(str(a.vmid)) == "running":
            out.append(
                Signal(
                    "assets.lab_on_lan",
                    "failed",
                    {"asset": a.label(), "nics": ", ".join(on_lan), "why": why_not},
                )
            )
        elif not iso[a.id][0]:
            out.append(
                Signal("assets.lab_not_isolated", "warn", {"asset": a.label(), "why": why_not})
            )
    counts = {t: sum(a.tier == t for a in reg.assets.values()) for t in assets.TIERS}
    out.append(Signal("assets.registry", "ok", {"n": len(reg.assets), **counts}))
    state["tiers"] = {aid: a.tier for aid, a in reg.assets.items()}
    state["isolation"] = {aid: v[0] for aid, v in iso.items()}
    state["discovered"] = [
        {k: guest.get(k) for k in ("vmid", "name", "type", "template", "tags", "pools")}
        for guest in guests
    ][:200]
    return out
