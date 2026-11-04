"""Asset registry and tiers: one record per asset, and the tier step that turns a check's state into the state it has
for the asset it is about.

Port of ns/assets.py (the registry, discovery, isolation evidence and the tier step). The registry is
data/assets.toml; PVE guests missing from it are discovered by the assets check and tiered at first sight. A tag or
pool (tier-lab, tier-standard, tier-critical, lab) suggests the tier, honoured only when it was there the first time
the guest was seen, so an agent can mark a guest it creates as lab but never lower one that exists. What the OmniNull
hub said about an endpoint (presence, isolation) is not read any more: isolation counts only with PVE NIC evidence.

Tier step, on warn and failed signals only (a note stays a note):
  health    lab assets only note it (state ok)
  security  never lowered; failed on a critical asset and on a lab asset that is not verifiably isolated
  data      never lowered; failed on an asset that holds data
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import stat
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from host_steward import core

TIERS = ("critical", "standard", "lab")
TIER_RANK = {"lab": 0, "standard": 1, "critical": 2}
PRESENCE = ("always_on", "intermittent", "parked")
ID_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,47}")
STATE_PATH = Path(os.environ.get("HOST_STEWARD_ASSETS") or "/var/lib/host-steward/assets.json")
LAB_USE_MAX_BYTES = 64 * 1024
LAB_USE_MAX_HOURS = 24


@dataclass(frozen=True)
class Asset:
    id: str
    tier: str = "standard"
    kind: str = "guest"  # host | router | vm | ct | template | endpoint
    vmid: int | None = None
    hosts: tuple[str, ...] = ()  # host names a host check reports under
    names: tuple[str, ...] = ()  # PVE guest names (lowercase)
    data: bool = False  # holds data or secrets
    isolated: bool = False  # declared; effective isolation also needs evidence (isolated_verified)
    presence: str = "always_on"
    at_rest: bool | None = None
    backup_targets: tuple[str, ...] = ()
    backup_copy: bool = False
    role: str = ""  # workstation | pve | router
    note: str = ""
    source: str = "site"  # site | discovered

    def label(self) -> str:
        return self.id + (f" ({self.vmid})" if self.vmid is not None else "")


@dataclass
class Registry:
    assets: dict[str, Asset] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)  # entries of the data file that were refused

    def by_host(self, host: str) -> Asset | None:
        return next((a for a in self.assets.values() if host in a.hosts), None)

    def by_role(self, role: str) -> Asset | None:
        return next((a for a in self.assets.values() if a.role == role), None)

    def by_vmid(self, vmid: Any) -> Asset | None:
        try:
            wanted = int(vmid)
        except (TypeError, ValueError):
            return None
        return next((a for a in self.assets.values() if a.vmid == wanted), None)

    def by_name(self, name: Any) -> Asset | None:
        if not isinstance(name, str) or not name:
            return None
        key = name.strip().lower()
        return self.assets.get(key) or next(
            (a for a in self.assets.values() if key in a.names), None
        )


def entry(aid: str, raw: Mapping[str, Any], source: str = "site") -> tuple[Asset | None, str]:
    """One data-file entry, validated; (None, why) when refused."""
    kw: dict[str, Any] = {"source": source}
    if raw.get("tier", "standard") not in TIERS:
        return None, f"{aid}: tier must be one of {', '.join(TIERS)}"
    if raw.get("presence", "always_on") not in PRESENCE:
        return None, f"{aid}: presence must be one of {', '.join(PRESENCE)}"
    for key in ("tier", "presence"):
        if key in raw:
            kw[key] = raw[key]
    for key in ("data", "isolated", "backup_copy"):
        if key in raw:
            if not isinstance(raw[key], bool):
                return None, f"{aid}: {key} must be true or false"
            kw[key] = raw[key]
    if "at_rest" in raw:
        kw["at_rest"] = raw["at_rest"] if isinstance(raw["at_rest"], bool) else None
    for key in ("hosts", "names", "backup_targets"):
        if key in raw:
            if not isinstance(raw[key], list) or not all(
                isinstance(x, str) and 0 < len(x) <= 64 for x in raw[key]
            ):
                return None, f"{aid}: {key} must be a list of short strings"
            kw[key] = tuple(x.lower() if key == "names" else x for x in raw[key])
    if "vmid" in raw:
        if (
            not isinstance(raw["vmid"], int)
            or isinstance(raw["vmid"], bool)
            or not 100 <= raw["vmid"] <= 999999999
        ):
            return None, f"{aid}: vmid must be a PVE guest id"
        kw["vmid"] = raw["vmid"]
    for key, limit in (("kind", 16), ("role", 16), ("note", 160)):
        if isinstance(raw.get(key), str):
            kw[key] = raw[key][:limit]
    return Asset(aid, **kw), ""


def load_file(directory: Path | None = None) -> dict[str, Any]:
    with ((directory or core.DATA_DIR) / "assets.toml").open("rb") as handle:
        return tomllib.load(handle)


def load(data: Mapping[str, Any] | None = None) -> Registry:
    """The registry from assets.toml (or an already loaded dict of the same shape)."""
    data = data if data is not None else load_file()
    reg = Registry()
    for raw in data.get("assets", []):
        aid = raw.get("id")
        if not isinstance(aid, str) or not ID_RE.fullmatch(aid) or aid in reg.assets:
            reg.problems.append(f"asset {str(aid)[:48]!r}: ids are unique lowercase names")
            continue
        asset, why = entry(aid, raw)
        if asset is None:
            reg.problems.append(why)
        else:
            reg.assets[aid] = asset
    return reg


def load_state(path: Path | None = None) -> dict[str, Any]:
    """What the assets check remembers (first-seen tiers, isolation verdicts, discovered guests). The check keeps it in
    the host-steward state file; until it has run once, assets.json (copied from Nightshift's) is the starting point."""
    if path is None:
        own = core.load_state().get("checks", {}).get("assets")
        if isinstance(own, dict) and own:
            return own
    try:
        data = json.loads((path or STATE_PATH).read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _slug(name: str, vmid: int) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-")[:40]
    return slug if slug and ID_RE.fullmatch(slug) else f"guest-{vmid}"


def tag_tier(tags: list[str], pools: list[str], tag_tiers: Mapping[str, str]) -> str | None:
    hits = [tag_tiers[t] for t in [*tags, *pools] if t in tag_tiers]
    return (
        max(hits, key=lambda t: TIER_RANK[t]) if hits else None
    )  # conflicting marks: the higher tier wins


def discover(
    reg: Registry,
    guests: list[dict[str, Any]],
    state: dict[str, Any],
    now: float,
    tag_tiers: Mapping[str, str],
) -> list[str]:
    """Add PVE guests missing from the registry; returns the ids added. state['first_seen'] keeps the tier each
    discovered guest got when it first appeared; a later tag can raise it but never lower it."""
    first: dict[str, Any] = state.setdefault("first_seen", {})
    added = []
    for g in guests:
        try:
            vmid = int(str(g.get("vmid")))
        except (TypeError, ValueError):
            continue
        if reg.by_vmid(vmid) is not None:
            continue
        name = str(g.get("name") or "")
        suggested = tag_tier(list(g.get("tags") or []), list(g.get("pools") or []), tag_tiers)
        rec = first.get(str(vmid))
        if not isinstance(rec, dict) or rec.get("tier") not in TIERS:
            base = suggested or ("lab" if g.get("template") else "standard")
            rec = first[str(vmid)] = {"tier": base, "at": now, "name": name[:64]}
        tier = str(rec["tier"])
        if suggested and TIER_RANK[suggested] > TIER_RANK[tier]:
            tier = rec["tier"] = suggested
        aid = _slug(name, vmid)
        if aid in reg.assets:
            aid = f"{aid}-{vmid}"
        kind = "template" if g.get("template") else ("ct" if g.get("type") == "ct" else "vm")
        reg.assets[aid] = Asset(
            aid, tier, kind, vmid, names=(name.lower(),) if name else (),
            presence="parked" if kind == "template" else "always_on", source="discovered",
            note=f"discovered on PVE; tier from {'tag' if suggested else 'default'} at first sight",
        )  # fmt: skip
        added.append(aid)
    return added


def registry_for_run(
    state: Mapping[str, Any], tag_tiers: Mapping[str, str], data: Mapping[str, Any] | None = None
) -> tuple[Registry, dict[str, bool]]:
    """The registry plus the guests the last assets run discovered, and its isolation verdicts: what the tier step
    uses in checks that run before (or without) the assets check."""
    reg = load(data)
    guests = [g for g in state.get("discovered") or [] if isinstance(g, dict)]
    discover(reg, guests, {"first_seen": dict(state.get("first_seen") or {})}, 0.0, tag_tiers)
    return reg, {k: v is True for k, v in (state.get("isolation") or {}).items()}


# ------------------------------------------------------------------ isolation evidence


def lab_vlans(values: list[Any]) -> frozenset[str]:
    """VLAN tags on a LAN bridge that count as off the LAN. Tag 1 never does: on a VLAN-aware bridge it is the
    default PVID, the untagged home LAN."""
    return frozenset(str(t) for t in values if str(t).isdigit() and str(t) not in ("0", "1"))


def _trunk_vlans(spec: str) -> set[int] | None:
    """PVE trunks= ('10;20-22') -> its VLAN ids; None when it does not parse (counted as reaching anything)."""
    out: set[int] = set()
    for part in (x.strip() for x in spec.split(";")):
        m = re.fullmatch(r"(\d{1,4})(?:-(\d{1,4}))?", part)
        if not m:
            if part:
                return None
            continue
        lo, hi = int(m[1]), int(m[2] or m[1])
        if not 1 <= lo <= hi <= 4094:
            return None
        out |= set(range(lo, hi + 1))
    return out


def on_lan(
    nic: Mapping[str, Any], lan_bridges: list[str], vlans: frozenset[str] = frozenset()
) -> bool:
    """A NIC on a LAN bridge is on the LAN unless its VLAN tag is a configured lab VLAN (the PVE token can set any
    tag). A trunk lets the guest send tagged frames on each VLAN it lists, so every one must be a lab VLAN too."""
    if nic.get("bridge") not in lan_bridges:
        return False
    if str(nic.get("tag") or "") not in vlans:
        return True
    trunks = _trunk_vlans(str(nic.get("trunks") or ""))
    return trunks is None or any(str(v) not in vlans for v in trunks)


def isolated_verified(
    a: Asset,
    nets: Mapping[str, list[dict[str, Any]]],
    lan_bridges: list[str],
    vlans: frozenset[str] = frozenset(),
) -> tuple[bool, str]:
    """Declared isolation only counts with evidence: every PVE NIC of the guest sits off the LAN bridges (another
    bridge, or a configured lab VLAN tag) with the PVE firewall on."""
    nics = nets.get(str(a.vmid)) if a.vmid is not None else None
    if nics == []:
        return True, "no network interface"
    if not a.isolated:
        return False, "not declared isolated"
    if not nics:
        return False, "declared isolated, but no NIC evidence"
    bad = [n["slot"] for n in nics if not n.get("firewall") or on_lan(n, lan_bridges, vlans)]
    if bad:
        return (
            False,
            f"declared isolated, but {', '.join(bad)} is on the LAN or without the PVE firewall",
        )
    return True, "every NIC off the LAN bridge with the PVE firewall on"


# ------------------------------------------------------------------ tier step


def finding_class(code: str, classes: list[list[str]]) -> str:
    for pattern, cls in classes:
        if fnmatch.fnmatchcase(code or "", pattern):
            return cls
    return "health"


def tier_state(state: str, cls: str, a: Asset, isolated: bool) -> str:
    """The state a signal of class `cls` has for asset `a`. Notes (ok) and off stay as they are."""
    if state not in ("warn", "failed"):
        return state
    if cls == "health":
        return "ok" if a.tier == "lab" else state
    if cls == "security":
        return "failed" if a.tier == "critical" or (a.tier == "lab" and not isolated) else state
    if cls == "data":
        return "failed" if a.data else state
    return state


def tier_signal(sig: core.Signal, cls: str, a: Asset, isolated: bool) -> core.Signal:
    """The signal after the tier step; a problem lowered to ok stays in the row's text as a note."""
    state = tier_state(sig.state, cls, a, isolated)
    if state == sig.state:
        return sig
    return core.Signal(sig.code, state, sig.fields, note=sig.note or state == "ok")


# ------------------------------------------------------------------ lab-use claims


def lab_claims(paths: list[str], now: float) -> dict[str, dict[str, Any]]:
    """Unexpired lab-use declarations (an agent session says it uses a parked machine): asset id or vmid -> who and
    why. Same rules as Nightshift's reader: a regular file, not world-writable, at most 64 KiB; entries validated."""
    out: dict[str, dict[str, Any]] = {}
    for path in paths:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        except OSError:
            continue
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_mode & 0o002
                or info.st_size > LAB_USE_MAX_BYTES
            ):
                continue
            try:
                raw = json.loads(handle.read(LAB_USE_MAX_BYTES + 1))
            except (ValueError, RecursionError):
                continue
        for asset, e in list(raw.items() if isinstance(raw, dict) else [])[:50]:
            if not isinstance(asset, str) or not re.fullmatch(
                r"[a-z0-9][a-z0-9_-]{0,47}|[0-9]{3,9}", asset
            ):
                continue
            at, until = (e.get("at"), e.get("until")) if isinstance(e, dict) else (None, None)
            if (
                not isinstance(at, int | float)
                or not isinstance(until, int | float)
                or isinstance(at, bool)
                or isinstance(until, bool)
            ):
                continue
            if at > now + 60 or until <= now or until - at > LAB_USE_MAX_HOURS * 3600:
                continue
            clean = re.compile(r"[^A-Za-z0-9 _.,:;()/@+#'-]")
            out[asset] = {
                "until": float(until),
                "reason": " ".join(clean.sub("", str(e.get("reason") or "")).split())[:120]
                or "no reason given",
                "by": " ".join(clean.sub("", str(e.get("by") or "")).split())[:60]
                or "an agent session",
            }
    return out
