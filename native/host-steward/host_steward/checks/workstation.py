"""Workstation health: failed units, pending reboot and updates, firewall, swap and journald settings, memory
pressure, internet and tunnel reachability, shared containers, certificate expiry.

Port of Nightshift's ns/checks/workstation.py. Left out on purpose: the memory-kill and memctl liveness probes
(memctl moves in M5a-2), oomd, the browser VM and NVIDIA module notes.
"""

from __future__ import annotations

import json
import re
import socket
import ssl
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

from host_steward.core import Ctx, Signal

ID = "workstation"
INST = re.compile(r"^Inst (\S+) .*$", re.MULTILINE)


def failed_units(text: str, transient: re.Pattern[str]) -> tuple[list[str], list[str]]:
    """(real failed units, stale transient ones) from `systemctl list-units --failed --no-legend --plain`."""
    real, skipped = [], []
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        (skipped if transient.fullmatch(parts[0]) else real).append(parts[0])
    return real, skipped


def user_systemctl(uid: int) -> list[str]:
    """systemctl for the owner's manager, run as the owner with no login session (a login session logs journal errors)."""
    return [
        "/usr/bin/setpriv", f"--reuid={uid}", f"--regid={uid}", "--init-groups", "--",
        "/usr/bin/env", "-i", f"XDG_RUNTIME_DIR=/run/user/{uid}", "PATH=/usr/bin:/bin", "systemctl", "--user",
    ]  # fmt: skip


def units(ctx: Ctx) -> Signal:
    cfg = ctx.cfg
    transient = re.compile(cfg["transient_units"])
    system = ctx.run(["systemctl", "list-units", "--failed", "--no-legend", "--plain"], timeout=30)
    real, skipped = failed_units(system.out, transient)
    unread = ""
    if system.rc != 0:
        unread = (system.err or system.out).strip()[:80] or f"exit {system.rc}"
    user = ctx.run(
        [*user_systemctl(int(cfg["owner_uid"])), "list-units", "--failed", "--no-legend", "--plain"], timeout=30
    )
    if user.rc == 0:
        more, more_skipped = failed_units(user.out, transient)
        real += [f"{unit} (user)" for unit in more]
        skipped += more_skipped
    else:
        unread = unread or "the owner's user manager did not answer"
    if unread:
        return Signal("ws.units.unreadable", "warn", {"why": unread, "units": ", ".join(real[:5])})
    if real:
        return Signal("ws.units.failed", "warn", {"n": len(real), "units": ", ".join(real[:5])})
    return Signal("ws.units.failed", "ok", {"n": 0, "skipped": len(skipped)})


def reboot(ctx: Ctx) -> Signal:
    if Path(ctx.cfg["reboot_flag"]).exists():
        return Signal("ws.reboot.required", "warn")
    return Signal("ws.reboot.required", "ok")


def installable(text: str) -> dict[str, bool]:
    """package -> True when its candidate comes from a security pocket (`apt-get -s` Inst lines)."""
    return {m.group(1): "security" in m.group(0).lower() for m in INST.finditer(text)}


def apt(ctx: Ctx) -> Signal:
    up = ctx.run(["apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade"], timeout=120)
    dist = ctx.run(["apt-get", "-s", "-o", "Debug::NoLocking=1", "dist-upgrade"], timeout=120)
    if up.rc != 0 or dist.rc != 0:
        return Signal("ws.apt.unreadable", "warn", {"why": (dist.err or up.err).strip()[:80]})
    now, everything = installable(up.out), installable(dist.out)
    security_now = [name for name, sec in now.items() if sec]
    held = [name for name, sec in everything.items() if sec and name not in now]
    fields = {"pending": len(everything), "security": len(security_now) + len(held), "held": len(held)}
    if security_now or held:
        return Signal("ws.apt.pending", "warn", fields)
    return Signal("ws.apt.pending", "ok", fields, note=bool(everything))


def sysctl_drift(text: str, proc_root: str) -> dict[str, str]:
    drift = {}
    for line in text.splitlines():
        key, sep, want = line.split("#", 1)[0].partition("=")
        if not sep:
            continue
        key, want = key.strip(), want.strip()
        try:
            have = (Path(proc_root) / key.replace(".", "/")).read_text().strip()
        except OSError:
            have = ""
        if have.split() != want.split():
            drift[key] = have or "unreadable"
    return drift


def swap(ctx: Ctx) -> Signal:
    cfg = ctx.cfg
    text = ctx.read(cfg["swap_conf"])
    drift = sysctl_drift(text, cfg["proc_sys"]) if text is not None else {cfg["swap_conf"]: "missing"}
    for key, want in cfg["zswap_expect"].items():
        try:
            have = (Path(cfg["zswap_dir"]) / key).read_text().strip()
        except OSError:
            have = "unreadable"
        if have != want:
            drift[f"zswap.{key}"] = have
    if drift:
        return Signal("ws.swap.drift", "warn", {"n": len(drift), "keys": ", ".join(sorted(drift)[:4])})
    return Signal("ws.swap.drift", "ok")


def firewall(ctx: Ctx) -> Signal:
    result = ctx.run(["ufw", "status", "verbose"], timeout=30)
    if result.out.splitlines()[:1] == ["Status: active"]:
        return Signal("ws.ufw.active", "ok")
    return Signal("ws.ufw.active", "warn", {"why": (result.out or result.err).strip()[:60] or "no answer"})


def journald(ctx: Ctx) -> Signal:
    result = ctx.run(["systemd-analyze", "cat-config", "systemd/journald.conf"], timeout=30)
    effective: dict[str, str] = {}
    for line in result.out.splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and not line.lstrip().startswith(("#", ";")):
            effective[key.strip()] = value.strip()
    drift = {k: effective.get(k) for k, want in ctx.cfg["journald_expect"].items() if effective.get(k) != want}
    if result.rc != 0 or drift:
        return Signal("ws.journald.retention", "warn", {"keys": ", ".join(sorted(drift)) or "all"})
    return Signal("ws.journald.retention", "ok")


def pressure(ctx: Ctx) -> Signal:
    text = ctx.read(ctx.cfg["psi_memory"])
    if text is None:
        return Signal("ws.memory.pressure", "ok", {"detail": "Memory pressure is not readable here."}, note=True)
    avg = {}
    for line in text.splitlines():
        parts = line.split()
        if parts and parts[0] in ("some", "full"):
            avg[parts[0]] = float(dict(p.split("=") for p in parts[1:])["avg300"])
    limits = {"full": ctx.cfg["pressure_warn_full_pct"], "some": ctx.cfg["pressure_warn_some_pct"]}
    hot = {kind: value for kind, value in avg.items() if value >= limits[kind]}
    if hot:
        kind, value = next(iter(hot.items()))
        return Signal("ws.memory.pressure", "warn", {"kind": kind, "pct": f"{value:.1f}"})
    return Signal("ws.memory.pressure", "ok")


def fetch_url(url: str, timeout: float = 5) -> tuple[int, str]:
    """(HTTP status, first 4 KiB of the body), or (0, why) when nothing answered. Only data-file URLs are fetched."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status, response.read(4096).decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, ""
    except (OSError, ValueError) as error:
        return 0, str(error)[:120]


def internet(ctx: Ctx) -> Signal:
    probes = ctx.cfg["internet_probes"]
    if not probes or fetch_url(probes[0])[0]:
        return Signal("ws.net.internet", "ok")
    if any(fetch_url(url)[0] for url in probes[1:]):
        return Signal("ws.net.internet", "warn", {"how": "names do not resolve"})
    return Signal("ws.net.internet", "warn", {"how": "nothing answers"})


def tunnel(ctx: Ctx) -> Signal | None:
    url = ctx.cfg.get("tunnel_ready_url")
    if not url:
        return None
    status, body = fetch_url(url)
    try:
        ready = int(json.loads(body).get("readyConnections", 0)) if status == 200 else 0
    except (ValueError, AttributeError, TypeError):
        ready = 0
    if status == 200 and ready > 0:
        return Signal("ws.tunnel.cloudflared", "ok", {"n": ready})
    return Signal("ws.tunnel.cloudflared", "warn", {"status": status})


def containers(ctx: Ctx) -> Signal | None:
    names = ctx.cfg.get("core_containers") or []
    if not names:
        return None
    result = ctx.run(["docker", "inspect", "-f", "{{.Name}} {{.State.Status}}", *names], timeout=30)
    states = {}
    for line in result.out.splitlines():
        name, _, status = line.strip().lstrip("/").partition(" ")
        states[name] = status
    down = [name for name in names if states.get(name) != "running"]
    if down:
        return Signal("ws.infra.containers", "warn", {"names": ", ".join(down)})
    return Signal("ws.infra.containers", "ok")


def endpoint_expiry(name: str, addr: str, port: int, timeout: float = 10) -> float:
    """notAfter (unix time) of the certificate a TLS endpoint serves; unverified, so private CAs work."""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    with (
        socket.create_connection((addr, port), timeout=timeout) as sock,
        context.wrap_socket(sock, server_hostname=name) as tls,
    ):
        der = tls.getpeercert(binary_form=True)
    if not der:
        raise OSError("no certificate")
    return _der_not_after(der)


def _der_not_after(der: bytes) -> float:
    pem = ssl.DER_cert_to_PEM_cert(der)
    out = subprocess.run(
        ["openssl", "x509", "-noout", "-enddate"], input=pem, capture_output=True, text=True, check=True, timeout=15
    ).stdout
    match = re.search(r"notAfter=(.+)", out)
    if not match:
        raise OSError("no end date")
    return float(ssl.cert_time_to_seconds(match.group(1).strip()))


def parse_endpoint(spec: str) -> tuple[str, str, int]:
    """'name', 'name:port' or 'name@addr:port' -> (TLS server name, address to connect to, port)."""
    name, _, where = spec.partition("@")
    addr, _, port = (where or name).partition(":")
    return name.partition(":")[0], addr, int(port or 443)


def certificates(ctx: Ctx) -> Signal | None:
    specs = ctx.cfg.get("cert_endpoints") or []
    if not specs:
        return None
    left: dict[str, float] = {}
    for spec in specs:
        try:
            left[spec] = (endpoint_expiry(*parse_endpoint(spec)) - ctx.now) / 86400
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
    if not left:
        return Signal("ws.cert.expiry", "warn", {"n": len(specs), "worst": "none readable", "days": "?"})
    worst = min(left, key=lambda spec: left[spec])
    days = left[worst]
    fields = {"worst": worst, "days": f"{days:.0f}"}
    if days < ctx.cfg["cert_crit_days"]:
        return Signal("ws.cert.expiry", "failed", fields)
    if days < ctx.cfg["cert_warn_days"]:
        return Signal("ws.cert.expiry", "warn", fields)
    return Signal("ws.cert.expiry", "ok", fields)


def run(ctx: Ctx) -> list[Signal]:
    steps = (units, reboot, apt, swap, firewall, journald, pressure, internet, tunnel, containers, certificates)
    out: list[Signal] = []
    for step in steps:
        try:
            signal = step(ctx)
        except Exception as error:  # noqa: BLE001 - one probe must not hide the others
            signal = Signal("check.probe", "warn", {"probe": step.__name__, "why": f"{type(error).__name__}"})
        if signal is not None:
            out.append(signal)
    return out
