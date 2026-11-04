"""Public gates: each app published to the internet must refuse a visitor who has not logged in.

Port of ns/checks/gates.py. The check asks the router's resolver for the name (this host's own resolver may point
the name at the local proxy, which skips the gate, and asking a public DNS service directly would trip OmniNull's
resolver-bypass rule), keeps only a public address, opens HTTPS to it with the real name and sends one anonymous
GET of the app's gate path. A redirect to Cloudflare Access, or a 401/403, is a closed gate; a 200 means the app
answers the internet without a login. Nothing is sent but the GET. The app list and the resolver are in the data file.
"""

from __future__ import annotations

import http.client
import ipaddress
import os
import re
import socket
import ssl
from typing import Any

from host_steward.core import Ctx, Signal

ID = "gates"
NAME = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+")
ACCESS = re.compile(r"https://[a-z0-9-]+\.cloudflareaccess\.com/")


def router_address(name: str, server: str, timeout: float = 10) -> str:
    """The first public A record for name from the DNS server at `server` (one UDP query, standard library only).
    A local answer is refused: the probe must reach the gate the internet sees."""
    qid = os.urandom(2)
    query = (
        qid
        + b"\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00"
        + b"".join(bytes([len(p)]) + p.encode() for p in name.split("."))
        + b"\x00\x00\x01\x00\x01"
    )
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        sock.sendto(query, (server, 53))
        data = sock.recv(4096)
    if len(data) < 12 or data[:2] != qid or data[3] & 0x0F:
        raise OSError(f"{server} gave no usable answer for {name}")
    pos, local = 12, []
    questions, answers = int.from_bytes(data[4:6], "big"), int.from_bytes(data[6:8], "big")
    for i in range(questions + answers):
        while pos < len(data) and data[pos] and data[pos] < 0xC0:
            pos += data[pos] + 1
        pos += 2 if pos < len(data) and data[pos] >= 0xC0 else 1
        if i < questions:
            pos += 4
            continue
        rtype, rlen = int.from_bytes(data[pos : pos + 2], "big"), int.from_bytes(data[pos + 8 : pos + 10], "big")
        rdata, pos = data[pos + 10 : pos + 10 + rlen], pos + 10 + rlen
        if rtype == 1 and rlen == 4:
            ip = ipaddress.IPv4Address(rdata)
            if ip.is_global:
                return str(ip)
            local.append(str(ip))
    raise OSError(f"only local addresses for {name}" if local else f"no address for {name}")


def anonymous_get(name: str, ip: str, path: str, timeout: float = 10) -> tuple[int, str]:
    """(status, Location) of one GET to ip with the real name for TLS and Host; certificate verified."""
    context = ssl.create_default_context()
    conn = http.client.HTTPSConnection(name, 443, timeout=timeout, context=context)
    conn.sock = context.wrap_socket(socket.create_connection((ip, 443), timeout=timeout), server_hostname=name)
    try:
        conn.request("GET", path, headers={"User-Agent": "host-steward-gate-check", "Accept": "*/*"})
        response = conn.getresponse()
        return response.status, response.getheader("Location") or ""
    finally:
        conn.close()


def judge(status: int, location: str) -> tuple[str, str]:
    """(how it is closed, verdict): ok | open | odd."""
    if status in (301, 302, 303, 307, 308) and ACCESS.match(location):
        return "Cloudflare Access", "ok"
    if status in (401, 403):
        return f"the app's own login (HTTP {status})", "ok"
    if 200 <= status < 300:
        return "none", "open"
    return f"HTTP {status}", "odd"


def run(ctx: Ctx) -> list[Signal]:
    cfg: dict[str, Any] = ctx.cfg
    out = []
    for gate in cfg["apps"]:
        app, host, path = gate["app"], gate["host"], gate.get("path", "/")
        if not NAME.fullmatch(host) or not path.startswith("/"):
            out.append(Signal("gates.app", "warn", {"app": app, "why": "the data file entry is not valid"}))
            continue
        try:
            status, location = anonymous_get(host, router_address(host, cfg["dns_server"]), path)
        except (OSError, ValueError, http.client.HTTPException) as error:
            out.append(Signal("gates.app", "warn", {"app": app, "why": f"the probe could not run ({type(error).__name__})"}))
            continue
        how, verdict = judge(status, location)
        state = {"ok": "ok", "open": "failed", "odd": "warn"}[verdict]
        out.append(Signal("gates.app", state, {"app": app, "host": host, "how": how}))
    return out
