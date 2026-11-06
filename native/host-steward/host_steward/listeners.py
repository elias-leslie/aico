"""Listener tracking for the tripwire: the non-loopback sockets `ss` shows, who opened them, and what a change means.

Port of the listener half of ns/checks/tripwire.py. A listener change is a record, never an alert (owner
2026-10-31) unless the internet reaches it through a cloudflared ingress rule or a root login from outside the
workstation falls in its window. Pure functions on text and dicts; the check (checks/tripwire.py) supplies the
command output and /proc.
"""

from __future__ import annotations

import contextlib
import os
import re
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from host_steward import core

DPKG_LOG = Path("/var/log/dpkg.log")
DPKG_TAIL = 20000  # lines of dpkg.log read (a release upgrade writes thousands)
DPKG_SLACK_S = 300  # dpkg logs a package when it starts unpacking; a file lands (and a pass sees it) a little off
DPKG_ACT = re.compile(
    r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (?:install|upgrade|configure|trigproc) ([^\s:]+)"
)
CLOUDFLARED_CONFIG = Path("/etc/cloudflared/config.yml")
TRANSIENT = re.compile(r"\.(dpkg-(new|old|dist|tmp|bak|remove)|ucf-(new|old|dist))$")
Query = Callable[[list[str]], tuple[int, str]]


def _query(argv: list[str]) -> tuple[int, str]:
    result = core.run_command(argv, timeout=20)
    return result.rc, result.out


def untracked(path: str, live: frozenset[str] | set[str] = frozenset()) -> bool:
    """dpkg/ucf staging files and multicast listeners: never tracked (also hides events recorded before the filter).
    A path in `live` (a file a sudoers @include line names) is live config whatever its suffix and stays tracked."""
    if path.startswith("listen "):
        addr = path.split(" ", 2)[-1].rpartition(":")[0]
        return bool(_MULTICAST.match(addr))
    return path not in live and bool(TRANSIENT.search(path))


_LOOPBACK = re.compile(r"^(127\.|\[?::1\]?$|.*%lo$)")
_MAPPED_LOOPBACK = re.compile(
    r"^\[?::ffff:127\.", re.IGNORECASE
)  # an IPv6 socket bound to IPv4 loopback (JVM daemons); tracked
# Multicast group sockets (mDNS 224.0.0.251:5353, SSDP, ff02::fb) receive group traffic; they expose no service.
_MULTICAST = re.compile(r"^(22[4-9]|23\d)\.|^\[?ff[0-9a-f]{2}:", re.IGNORECASE)
EPHEMERAL_UDP = 32768


def parse_listeners(text: str) -> dict[str, str]:
    """`ss -tulpnH` lines -> {'listen tcp *:443': 'caddy'}; loopback binds and ephemeral UDP ports dropped."""
    out: dict[str, set[str]] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0] not in ("tcp", "udp"):
            continue
        addr, _, port = parts[4].rpartition(":")
        if not port.isdigit() or _LOOPBACK.match(addr) or _MULTICAST.match(addr):
            continue
        if parts[0] == "udp" and int(port) >= EPHEMERAL_UDP:
            continue
        addr, _, dev = addr.partition("%")
        if addr in (
            "*",
            "0.0.0.0",
            "[::]",
            "::",
        ):  # every address; 0.0.0.0%labnet: every address of one device only
            addr = f"*%{dev}" if dev else "*"
        elif dev and _LINK_LOCAL.match(
            addr.strip("[]").lower()
        ):  # a link-local address is only unique on its device
            addr = f"{addr}%{dev}"
        names = set(re.findall(r'\("([^"]+)",pid=', " ".join(parts[5:]))) or {"?"}
        out.setdefault(f"listen {parts[0]} {addr}:{port}", set()).update(names)
    return {k: ",".join(sorted(v))[:120] for k, v in sorted(out.items())}


def parse_remote_listeners(text: str) -> dict[str, str] | None:
    """The 'L <ss line>' lines of the remote snippet; None when ss did not finish (no 'LOK')."""
    lines = text.splitlines()
    if "LOK" not in lines:
        return None
    return parse_listeners("\n".join(ln[2:] for ln in lines if ln.startswith("L ")))


def diff(old: dict[str, str], new: dict[str, str]) -> dict[str, list[str]]:
    return {
        "added": sorted(new.keys() - old.keys()),
        "removed": sorted(old.keys() - new.keys()),
        "changed": sorted(p for p in old.keys() & new.keys() if old[p] != new[p]),
    }


BOOT_WINDOW_S = 45 * 60  # how long after a boot a returning daemon counts as boot noise
_LINK_LOCAL = re.compile(r"^(fe[89ab][0-9a-f]:|169\.254\.)")


def _split_dev(addr: str) -> tuple[str, str]:
    """'[fe80::1]%labnet' -> ('[fe80::1]', 'labnet'); '*%labnet' -> ('*', 'labnet'); no device -> (addr, '')."""
    bare, _, dev = addr.partition("%")
    return bare, dev


def addr_class(addr: str) -> str:
    """Address class of a listener: any (every address), device (every address of one device: `*%labnet`, or a bare
    0.0.0.0 key from releases that dropped the device), link-local (kept with its device, `[fe80::1]%labnet`),
    loopback or specific (one interface address)."""
    bare, dev = _split_dev(addr)
    a = bare.strip("[]").lower()
    if not dev and (bare == "*" or a == "::"):
        return "any"
    if bare == "*" or a in ("0.0.0.0", "::"):
        return "device"
    if _LINK_LOCAL.match(a):
        return "link-local"
    if a.startswith(("::ffff:127.", "127.")) or a == "::1":
        return "loopback"
    return "specific"


def _listen_parts(path: str) -> tuple[str, str, str] | None:
    """'listen udp [fe80::1]%labnet:67' -> ('udp', '[fe80::1]%labnet', '67')."""
    parts = path.split(" ", 2)
    if len(parts) != 3 or parts[0] != "listen":
        return None
    addr, _, port = parts[2].rpartition(":")
    return parts[1], addr, port


def _legacy(addr: str) -> bool:
    """A key from releases that dropped the device: a bare 0.0.0.0, or a link-local address without one."""
    cls = addr_class(addr)
    return addr == "0.0.0.0" or (cls == "link-local" and not _split_dev(addr)[1])


def _pairs(old: str, new: str) -> bool:
    """The same listener on a new address, not a change: an any-address one, or a link-local one on the same device
    (dnsmasq on a new fe80 address of the same bridge). Specific and device-bound addresses are their own identity."""
    oc, nc = addr_class(old), addr_class(new)
    if oc == nc == "any":
        return True
    od, nd = _split_dev(old)[1], _split_dev(new)[1]
    return oc == nc == "link-local" and bool(od) and od == nd


def rebinds(base: dict[str, str], current: dict[str, str], d: dict[str, list[str]]) -> set[str]:
    """Removed and added listener paths of the same process, protocol and port that are the same listener (_pairs):
    not a change (each removed path pairs with at most one added path). An older release's key without a device (bare
    0.0.0.0, device-less link-local) pairs once with the keyed form it stood for, only when exactly one current key of
    that class, process, protocol and port carries a device; otherwise it is a change."""

    def ident(path: str, procs: str) -> tuple[str, str, str] | None:
        q = _listen_parts(path)
        return (procs, q[0], q[2]) if q else None

    removed: dict[tuple[str, str, str], list[str]] = {}
    for p in d["removed"]:
        if (i := ident(p, base[p])) is not None:
            removed.setdefault(i, []).append(p)
    out: set[str] = set()
    for p in d["added"]:
        i, q = ident(p, current[p]), _listen_parts(p)
        if i is None or q is None or not removed.get(i):
            continue
        old = next(
            (r for r in removed[i] if (rq := _listen_parts(r)) and _pairs(rq[1], q[1])), None
        )
        if old is None and _split_dev(q[1])[1]:
            cls = addr_class(q[1])
            keyed = [
                c
                for c in current
                if ident(c, current[c]) == i
                and (cq := _listen_parts(c))
                and addr_class(cq[1]) == cls
                and _split_dev(cq[1])[1]
            ]
            legacy = [
                r
                for r in removed[i]
                if (rq := _listen_parts(r)) and _legacy(rq[1]) and addr_class(rq[1]) == cls
            ]
            old = legacy[0] if len(keyed) == 1 and len(legacy) == 1 else None
        if old is not None:
            removed[i].remove(old)
            out |= {p, old}
    return out


def _came_back(old: str, new: str) -> bool:
    """A listener on `new` after a boot is the one on `old` before it: the same address or device, a link-local address
    on the same device, or a narrower exposure (loopback; every address -> anything; one device -> a link-local address
    on it). A different address or device of the same class is a change, and so is any widening."""
    if old == new:
        return True
    oc, nc = addr_class(old), addr_class(new)
    od, nd = _split_dev(old)[1], _split_dev(new)[1]
    if nc == "loopback" or oc == "any":
        return True
    if oc == nc == "link-local" or (oc == "device" and nc == "link-local"):
        return bool(od) and od == nd
    return oc == nc == "device" and bool(od) and od == nd


def boot_returns(base: dict[str, str], current: dict[str, str], paths: list[str]) -> bool:
    """True when every listener path (added, changed or removed) is a daemon coming back after a boot: each one open now
    has its process, protocol and port before the boot on an address it came back to (_came_back), and closings are
    less exposure."""
    before: dict[tuple[str, str, str], list[str]] = {}
    for p, procs in base.items():
        if q := _listen_parts(p):
            before.setdefault((procs, q[0], q[2]), []).append(q[1])
    for p in paths:
        if p not in current:
            continue
        q = _listen_parts(p)
        if q is None or not any(
            _came_back(o, q[1]) for o in before.get((current[p], q[0], q[2]), [])
        ):
            return False
    return True


def what_changed(old: dict[str, str], new: dict[str, str], path: str) -> str:
    a, b = old.get(path, "").split(" "), new.get(path, "").split(" ")
    if len(a) < 4 or len(b) < 4:
        return "changed"
    parts = []
    if a[0] != b[0]:
        parts.append("content")
    if a[1] != b[1]:
        parts.append("owner")
    if a[2] != b[2]:
        parts.append(f"mode {a[2]}->{b[2]}")
    if a[3:] != b[3:]:
        parts.append("type/link")
    return "+".join(parts) or "changed"


def item(path: str, how: str, sig: str) -> str:
    if not path.startswith("listen "):
        return f"{path} {sig if how == 'changed' else how}"
    where = path.removeprefix("listen ")
    return {"added": f"new listener {where} ({sig})", "removed": f"listener {where} closed"}.get(
        how, f"{where} now {sig}"
    )


def _headline(e: dict[str, Any]) -> str:
    """A phone headline for a listener-only event with several listeners ('6 new UDP listeners on :3702 (python3)');
    the address list follows it. '' for a file change, or when no two listeners share a protocol, kind and process:
    the item list is as short."""
    det = e.get("detail", {})
    paths = [(how, p) for how in ("added", "changed", "removed") for p in e.get(how, [])]
    groups: dict[tuple[str, str, str], list[str]] = {}
    for how, p in paths:
        q = _listen_parts(p)
        if q is None:
            return ""
        groups.setdefault((how, q[0], "" if how == "removed" else str(det.get(p, ""))), []).append(
            q[2]
        )
    if (
        max((len(v) for v in groups.values()), default=0) < 2
    ):  # nothing to sum up: the list says it as briefly
        return ""
    parts = []
    for (how, proto, procs), ports in groups.items():
        uniq = list(dict.fromkeys(ports))
        on = ", ".join(f":{x}" for x in uniq[:3]) + (
            f" and {len(uniq) - 3} more ports" if len(uniq) > 3 else ""
        )
        noun = f"{proto.upper()} listener{'' if len(ports) == 1 else 's'}"
        by = f" ({procs})" if procs else ""
        parts.append(
            {
                "added": f"{len(ports)} new {noun} on {on}{by}",
                "changed": f"{len(ports)} {noun} on {on} changed{by}",
                "removed": f"{len(ports)} {noun} on {on} closed",
            }[how]
        )
    return "; ".join(parts)


def change_line(e: dict[str, Any], items: list[str], what: str, when: str) -> str:
    listed = "; ".join(items[:6]) + (f" (+{len(items) - 6} more)" if len(items) > 6 else "")
    head = _headline(e)
    return f"{head} ({when}). Listeners: {listed}" if head else f"{what} changed ({when}): {listed}"


def hhmm(at: float, since: float) -> str:
    """'06:00' on the day of `since`, 'Fri 06:00' on a later day."""
    a, s = (datetime.fromtimestamp(float(t), UTC).astimezone() for t in (at, since))
    return a.strftime("%H:%M" if a.date() == s.date() else "%a %H:%M")


def close_gone(events: list[dict[str, Any]], current: dict[str, str], now_ts: float) -> bool:
    """An unanswered listener-only event closes itself (a board note, history kept) once every listener it opened has
    stayed closed for two consecutive checks: a later pass recorded the closing and this pass finds it gone, with
    nothing it could have rebound to (rebinds() moves a listener without an event, so a recorded removal proves
    nothing while a listener it pairs with is open).
    An event with any other evidence (a file change, root logins in its window) stays open; one past its hold closes
    too, so the history says how it ended. Returns whether any closed."""
    live = [q for c in current if (q := _listen_parts(c))]

    def rebound(q: tuple[str, str, str]) -> bool:
        # any process: _pairs, or the legacy device-less key rule, read loosely (same class is enough)
        return any(
            c[0] == q[0]
            and c[2] == q[2]
            and (
                _pairs(q[1], c[1])
                or _pairs(c[1], q[1])
                or ((_legacy(q[1]) or _legacy(c[1])) and addr_class(q[1]) == addr_class(c[1]))
            )
            for c in live
        )

    changed = False
    for i, e in enumerate(events):
        opened = [*e.get("added", []), *e.get("changed", [])]
        if (
            e.get("ack")
            or not opened
            or e.get("logins")
            or not all(p.startswith("listen ") for p in [*opened, *e.get("removed", [])])
        ):
            continue
        closes = []
        for p in opened:
            last = next(
                (
                    x
                    for x in reversed(events[i + 1 :])
                    if p in [*x.get("added", []), *x.get("changed", []), *x.get("removed", [])]
                ),
                None,
            )
            q = _listen_parts(p)
            if (
                q is None
                or p in current
                or rebound(q)
                or last is None
                or p not in last.get("removed", [])
                or float(last.get("at", 0)) >= now_ts
            ):
                break
            closes.append(float(last["at"]))
        else:
            at = max(closes)
            e.update(
                ack=True,
                ack_at=now_ts,
                closed_at=at,
                recorded=True,
                explained=True,
                ack_note=f"closed again at {hhmm(at, float(e['at']))}; nothing to do",
            )
            changed = True
    return changed


Query = Callable[[list[str]], tuple[int, str]]


def _dpkg_activity(dpkg_log: Path) -> list[tuple[float, str]]:
    """(time, package) of the recent install/upgrade/configure/trigproc lines of dpkg's log (local time)."""
    try:
        lines = dpkg_log.read_text(errors="replace").splitlines()[-DPKG_TAIL:]
    except OSError:
        return []
    out = []
    for ln in lines:
        m = DPKG_ACT.match(ln)
        if m:
            with contextlib.suppress(ValueError):
                out.append(
                    (datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").timestamp(), m.group(2))
                )
    return out


def _owners(path: str, query: Query) -> list[str]:
    """The packages dpkg says own `path` (none for a diverted or unowned path)."""
    rc, out = query(["dpkg-query", "-S", path])
    line = out.splitlines()[0] if rc == 0 and out else ""
    if ": " not in line or line.startswith("diversion"):
        return []
    return [x.split(":")[0].strip() for x in line.split(": ", 1)[0].split(",") if x.strip()]


def dpkg_explains(
    paths: list[str],
    removed: list[str],
    now_ts: float,
    since: float | None,
    dpkg_log: Path = DPKG_LOG,
    query: Query = _query,
) -> str:
    """'' unless every changed/added path belongs to a package that dpkg installed, upgraded or configured since the
    previous check (`since`, less DPKG_SLACK_S); then a note naming the packages. Content is not compared: maintainer
    scripts rewrite conffiles (pam-auth-update, sshd_config merges). Only files dpkg owns qualify and removals never
    do, so an agent's own file or edit still asks."""
    if removed or not paths or since is None:
        return ""
    recent = {
        pkg
        for t, pkg in _dpkg_activity(dpkg_log)
        if since - DPKG_SLACK_S <= t <= now_ts + DPKG_SLACK_S
    }
    used: set[str] = set()
    for path in paths:
        hit = recent.intersection(_owners(path, query))
        if not hit:
            return ""
        used.add(min(hit))
    return f"package update by dpkg ({', '.join(sorted(used)[:6])})"[:200]


_VETH = re.compile(r"^veth[0-9a-f]+$")
# Docker bridges: docker0 and one br-<network id> per user-defined network, each with a new address when created.
_BRIDGE = re.compile(r"^(docker0|br-[0-9a-f]{12})$")
_FAMILIES = ((_VETH, "veth*"), (_BRIDGE, "docker-bridge"))


def _manifest_key(path: str, devices: dict[str, str] | None = None) -> str:
    """The manifest entry a listener path is declared by: itself, or a container interface family form. A link-local
    bind on a container veth or Docker bridge is 'listen udp [fe80::]%veth*:3702' or '...%docker-bridge:3702'; a bind
    on an address that `devices` (interface_devices: address -> device, read live) puts on a Docker bridge is
    'listen udp <address>%docker-bridge:3702'. Each interface keeps its own key in the baseline, so every new one is
    still an event; the manifest's process and unit are checked live for each."""
    q = _listen_parts(path)
    if not q:
        return path
    bare, dev = _split_dev(q[1])
    cls = addr_class(q[1])
    family = next((name for rx, name in _FAMILIES if rx.match(dev)), "")
    if family and cls == "link-local":
        return (
            f"listen {q[0]} {'[fe80::]' if bare.startswith('[') else '169.254.0.0'}%{family}:{q[2]}"
        )
    if (
        not dev
        and cls == "specific"
        and devices
        and _BRIDGE.match(devices.get(bare.strip("[]").lower(), ""))
    ):
        return f"listen {q[0]} <address>%docker-bridge:{q[2]}"
    return path


def interface_devices(text: str) -> dict[str, str]:
    """Local interface addresses -> their device (from `ip -o addr show`), lowercase and without the prefix length; an
    address on two devices maps to '' (no device: never a Docker bridge)."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[2] in ("inet", "inet6"):
            addr = parts[3].partition("/")[0].lower()
            out[addr] = parts[1] if out.get(addr, parts[1]) == parts[1] else ""
    return out


def listener_units(text: str, proc: Path = Path("/proc")) -> dict[str, set[str]]:
    """Local listeners -> the cgroups of their processes (from `ss -tulpnH` pids and /proc/<pid>/cgroup)."""
    out: dict[str, set[str]] = {}
    for line in text.splitlines():
        key = next(iter(parse_listeners(line)), None)
        if key is None:
            continue
        for pid in re.findall(r",pid=(\d+),", line):
            try:
                unit = (proc / pid / "cgroup").read_text().strip().partition("::")[2]
            except OSError:
                unit = "?"
            out.setdefault(key, set()).add(unit)
    return out


def declared_listeners(
    manifest: list[dict[str, Any]],
    paths: list[str],
    current: dict[str, str],
    units: Callable[[], dict[str, set[str]]] | None = None,
    devices: Callable[[], dict[str, str]] | None = None,
) -> str:
    """'' unless every listener path (added/changed/removed) is declared for this host's role in the data file's
    expected-listeners list (`manifest`: that role's entries) and, when it listens now, by a declared process name and (entries with "unit") only from
    that systemd unit, checked live through `units`; then a note naming the entries. A process name alone is weak
    (any user can name a process), hence the unit where it can be checked. A listen address `[fe80::]%veth*` covers a
    link-local bind on any container veth, `[fe80::]%docker-bridge` and `<address>%docker-bridge` one on any Docker
    bridge, its address checked live through `devices` (_manifest_key). A missing or malformed manifest, or a "unit"
    entry without a live unit lookup, explains nothing (fail closed); without `devices` no bridge address matches."""
    try:
        entries = {
            f"listen {e['listen']}": (set(e["processes"]), str(e["ref"]), e.get("unit"))
            for e in manifest
        }
    except (KeyError, TypeError, AttributeError):
        return ""
    refs: list[str] = []
    live: dict[str, set[str]] | None = None
    devs: dict[str, str] | None = None
    for p in paths:
        e = entries.get(p) or entries.get(_manifest_key(p))
        if (
            e is None and devices is not None and p in current
        ):  # a bridge address: only while it is on the bridge
            devs = devices() if devs is None else devs
            e = entries.get(_manifest_key(p, devs))
        if e is None:
            return ""
        procs = {x for x in str(current.get(p, "")).split(",") if x}
        if procs - e[0]:  # present now with an undeclared process (removed listeners have none)
            return ""
        if procs and e[2]:
            if units is None:
                return ""
            live = units() if live is None else live
            if not live.get(p) or not all(u.endswith(f"/{e[2]}") for u in live[p]):
                return ""
        refs.append(f"{_manifest_key(p, devs)[len('listen ') :]} ({e[1][:80]})")
    return ("declared listener " + "; ".join(sorted(set(refs))))[:200] if refs else ""


def traced_listeners(
    manifest: list[dict[str, Any]],
    paths: list[str],
    current: dict[str, str],
    state: dict[str, Any],
    actors: Callable[[], dict[str, dict[str, Any]]] | None,
    units: Callable[[], dict[str, set[str]]] | None,
    tunnel: frozenset[int] | None = None,
    devices: Callable[[], dict[str, str]] | None = None,
) -> tuple[str, dict[str, dict[str, Any]]]:
    """('note', {path: actor}) when every listener path is declared, traced live to one of our agent sessions or
    services, or closed; ('', who) otherwise. A closed listener exposes less: it is named
    (with whoever opened it, when that was traced) and never asks. An agent's listener on a port a cloudflared ingress
    rule targets (`tunnel`) is public, so it is not traced."""
    try:  # attribution only ever removes an ask: when it fails, the change asks as before
        live = actors() if actors is not None and any(p in current for p in paths) else {}
    except Exception:  # noqa: BLE001 - attribution is best effort
        live = {}
    raw = state.get("listen_actors")
    known: dict[str, Any] = raw if isinstance(raw, dict) else {}
    who: dict[str, dict[str, Any]] = {}
    declared: list[str] = []
    ok = True
    for p in paths:
        if p in current and declared_listeners(
            manifest, [p], current, units=units, devices=devices
        ):
            declared.append(
                p
            )  # declared outranks attribution: the manifest is what the drill and the owner rely on
            continue
        actor = live.get(p) if p in current else known.get(p)
        if (
            p in current
            and tunnel
            and isinstance(actor, dict)
            and actor.get("kind") == "agent"
            and port(p) in tunnel
        ):
            actor = None
        if isinstance(actor, dict) and actor.get("label"):
            who[p] = {
                k: v
                for k, v in actor.items()
                if k in ("kind", "tool", "widget", "project", "via", "cwd", "unit", "label")
            }
            if p in current and actor.get("kind") == "agent" and not loopback_only(p):
                who[p]["loose"] = (
                    True  # agents' test/dev servers belong on 127.0.0.1 (loopback is never tracked)
                )
        elif p in current:
            ok = False
    if not ok:
        return "", who
    closed = [p for p in paths if p not in current and p not in who]
    parts = (
        [f"{p.removeprefix('listen ')} by {a['label']}" for p, a in who.items()]
        + [f"{p.removeprefix('listen ')} declared" for p in declared]
        + [f"{p.removeprefix('listen ')} closed" for p in closed]
    )
    return ("traced listener " + "; ".join(parts))[:200], who


def outside_login(logins: Any) -> bool:
    """A root login from anywhere but the workstation in the event's window (PVE): it keeps the event an alert."""
    return isinstance(logins, list) and any(
        not (isinstance(x, dict) and x.get("workstation")) for x in logins
    )


def exposed_listeners(
    paths: list[str],
    current: dict[str, str],
    explained: set[str] | list[str],
    tunnel: frozenset[int] | None,
) -> list[str]:
    """Listeners open now on a port a cloudflared ingress rule sends internet traffic to (`tunnel`), that nothing
    declared or traced to one of our services (`explained`): real exposure, the only listener change that still
    alerts. TCP only (cloudflared ingress origins are TCP). Unknown ingress ports (None) expose nothing known."""
    return [
        p
        for p in paths
        if p.startswith("listen tcp ")
        and p in current
        and p not in explained
        and tunnel
        and port(p) in tunnel
    ]


def novelty_note(
    paths: list[str],
    procs: dict[str, Any],
    removed: list[str],
    who: dict[str, Any],
    declared: list[str],
    tunnel_known: bool = True,
) -> str:
    """The board note for a listener change nothing exposes to the internet (owner 2026-10-31: network novelty is a
    record, never an alert): who opened each one when traced, else its process (`procs`), and which closed."""
    parts = []
    for p in paths:
        where, a = p.removeprefix("listen "), who.get(p)
        if p in removed:
            parts.append(
                f"{where} closed"
                + (f" (opened by {a['label']})" if isinstance(a, dict) and a.get("label") else "")
            )
        elif isinstance(a, dict) and a.get("label"):
            parts.append(f"{where} by {a['label']}")
        elif p in declared:
            parts.append(f"{where} declared")
        else:
            parts.append(f"{where} ({procs.get(p) or '?'})")
    tail = "" if tunnel_known else " (tunnel ports unreadable)"
    return ("recorded listener " + "; ".join(parts))[: 200 - len(tail)] + tail


def record_novelty(
    events: list[dict[str, Any]],
    current: dict[str, str],
    now_ts: float,
    hold_hours: float,
    ports: frozenset[int] | None,
    tunnel_known: bool,
) -> bool:
    """Unanswered listener-only events (from releases before the novelty rule, or whose exposure ended) become board
    records each pass: no listener of theirs open now on a tunnelled port, no root login from outside the workstation.
    An event that was exposed keeps asking while the ingress ports are unreadable. Returns whether any changed."""
    changed = False
    for e in events:
        paths = [*e.get("changed", []), *e.get("added", []), *e.get("removed", [])]
        if (
            e.get("ack")
            or now_ts - float(e.get("at", 0)) > hold_hours * 3600
            or not paths
            or not all(isinstance(p, str) and p.startswith("listen ") for p in paths)
            or outside_login(e.get("logins"))
            or all(untracked(p) for p in paths)
        ):
            continue
        w, dl = e.get("who"), e.get("declared")
        who: dict[str, Any] = w if isinstance(w, dict) else {}
        declared: list[str] = dl if isinstance(dl, list) else []
        exposed = exposed_listeners(
            [*e.get("changed", []), *e.get("added", [])], current, {*who, *declared}, ports
        )
        was = e.get("exposed") if isinstance(e.get("exposed"), list) else []
        # an exposure alert whose listeners all closed ends through close_gone (closed for two checks); one whose
        # open ports no ingress rule targets any more (ingress ports readable) becomes a record
        if exposed or (was and (not tunnel_known or all(p not in current for p in was))):
            continue  # `exposed` is never rewritten here: an approval the owner opened keeps its fingerprint
        det = e.get("detail")
        note = novelty_note(
            paths,
            {**current, **(det if isinstance(det, dict) else {})},
            list(e.get("removed", [])),
            who,
            declared,
            tunnel_known,
        )
        e.pop("exposed", None)
        e.update(ack=True, ack_at=now_ts, ack_note=note, explained=True, recorded=True)
        changed = True
    return changed


DAEMON_DIRS = ("/usr/sbin/", "/sbin/", "/usr/lib/systemd/", "/lib/systemd/", "/usr/libexec/")
SYSTEM_CGROUPS = (
    "/system.slice/",
    "/init.scope",
)  # system services and pid 1, never a login or user session


def package_listeners(
    paths: list[str],
    current: dict[str, str],
    now_ts: float,
    since: float | None,
    ss_text: str,
    dpkg_log: Path = DPKG_LOG,
    query: Query = _query,
    proc: Path = Path("/proc"),
) -> str:
    """'' unless every listener that is open now runs from a system unit (not a login or user session) out of a daemon
    binary of a package dpkg touched since the previous check (an sshd restarted by its upgrade, or socket-activated
    by systemd); closed listeners are not judged here. The process is read from /proc (its exe and cgroup), never
    its name: any user can name a process."""
    live = [p for p in paths if p in current]
    if not live or since is None:
        return ""
    recent = {
        pkg
        for t, pkg in _dpkg_activity(dpkg_log)
        if since - DPKG_SLACK_S <= t <= now_ts + DPKG_SLACK_S
    }
    if not recent:
        return ""
    pids: dict[str, set[str]] = {}
    for line in ss_text.splitlines():
        key = next(iter(parse_listeners(line)), None)
        if key is not None:
            pids.setdefault(key, set()).update(re.findall(r",pid=(\d+),", line))
    used: dict[str, set[str]] = {}
    for p in live:
        if not pids.get(p):
            return ""
        for pid in pids[p]:
            try:
                exe = os.readlink(proc / pid / "exe")
                cgroup = (proc / pid / "cgroup").read_text().strip().partition("::")[2]
            except OSError:
                return ""
            hit = (
                recent.intersection(_owners(exe, query))
                if exe.startswith(DAEMON_DIRS) and cgroup.startswith(SYSTEM_CGROUPS)
                else set()
            )
            if not hit:
                return ""
            used.setdefault(p, set()).add(min(hit))
    return (
        "package update by dpkg: "
        + "; ".join(
            f"{p.removeprefix('listen ')} ({', '.join(sorted(v))})" for p, v in used.items()
        )
    )[:200]


def loopback_only(path: str) -> bool:
    addr = path.split(" ", 2)[-1].rpartition(":")[0]
    return bool(_LOOPBACK.match(addr) or _MAPPED_LOOPBACK.match(addr))


def port(path: str) -> int:
    return int(path.rpartition(":")[2])


def tunnel_ports(path: Path = CLOUDFLARED_CONFIG) -> frozenset[int] | None:
    """Ports the cloudflared ingress rules send traffic to (any host: a loopback listener on one is public). None when
    the config is missing, unreadable or has no ingress list: the tripwire then uses the last ports it read (kept in its
    state), and only with none ever read records a new listener with "(tunnel ports unreadable)" in its note."""
    try:
        text = path.read_text()
    except OSError:
        return None
    text = "\n".join(ln for ln in text.splitlines() if not ln.lstrip().startswith("#"))
    urls = re.findall(r"^\s*(?:-\s*)?service:\s*[\"']?([^\s\"'#{}\[\],]+)", text, re.MULTILINE)
    # every service key must be a plain block entry (no YAML parser here): flow or quoted forms make the list unknown
    if not re.search(r"^ingress:\s*$", text, re.MULTILINE) or len(urls) != len(
        re.findall(r"service[\"']?\s*:", text)
    ):
        return None
    ports: set[int] = set()
    for url in urls:
        try:
            u = urlsplit(url)
            port = u.port or {"http": 80, "https": 443}.get(u.scheme) if u.netloc else None
        except ValueError:
            return None
        if port:
            ports.add(port)
        elif u.netloc or url.partition(":")[0].lower() not in (
            "unix",
            "unix+tls",
            "http_status",
            "hello_world",
            "bastion",
        ):
            return None  # an origin this reader cannot place (folded or anchored value, a port it cannot tell)
    return frozenset(ports)


def remember_actors(
    state: dict[str, Any], current: dict[str, str], who: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    """Who opened each listener that is still open, so its closing names them too."""
    raw = state.get("listen_actors")
    old: dict[str, Any] = raw if isinstance(raw, dict) else {}
    merged = {**old, **{p: a for p, a in who.items() if p in current}}
    return {p: a for p, a in merged.items() if p in current}
