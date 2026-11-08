"""Root's small grant service. One socket, frozen requests, FIDO assertions and a metadata-only use log.

The tray signs exactly the request/decision challenge. Test access has no authority and can be
approved by root for an unattended drill; that operation never approves a real kind.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import pwd
import re
import secrets
import socket
import socketserver
import stat
import struct
import time
import tomllib
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any

import aico_status
from host_steward import core, webauthn


def config() -> dict[str, Any]:
    with (core.DATA_DIR / "grants.toml").open("rb") as handle:
        return tomllib.load(handle)


def call(msg: dict[str, Any], path: str | None = None) -> dict[str, Any]:
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(10)
        client.connect(path or config()["socket"])
        client.sendall(json.dumps(msg).encode() + b"\n")
        with client.makefile("rb") as stream:
            out = json.loads(stream.readline(1 << 20))
    if "error" in out:
        raise ValueError(out["error"])
    return out


def post_notice(cfg: dict[str, Any], req: dict[str, Any]) -> bool:
    body = {
        "v": 1, "source": "aico", "kind": "info", "severity": "warning",
        "title": req["title"], "body": f"{req['reason']} Approve in the Aico tray or deny.",
        "key": f"approve:elevate:{req['id']}", "push": "phone", "interrupt": "needs-you",
        "open": f"{cfg['public_url']}?request={req['id']}",
    }
    try:
        request = urllib.request.Request(cfg["notice_url"], json.dumps(body).encode(),
                                         {"Content-Type": "application/json"})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5):
            return True
    except OSError:
        return False


def resolve_notice(cfg: dict[str, Any], req: dict[str, Any]) -> bool:
    """Ends the request's notice once it is no longer pending (answered, expired or revoked): an unanswered
    "Open your main Chrome?" would otherwise stay unread in the tray after there was nothing left to answer."""
    body = {"source": "aico", "key": f"approve:elevate:{req['id']}", "text": f"Access request {req['state']}."}
    try:
        request = urllib.request.Request(cfg["notice_url"].removesuffix("/api/notices") + "/api/notices/resolve",
                                         json.dumps(body).encode(), {"Content-Type": "application/json"})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5):
            return True
    except OSError:
        return False


# How long a finished (denied, revoked, expired) request keeps its Status row.
FINISHED_KEEP_S = 86400


class Grants:
    def __init__(self, cfg: dict[str, Any], now=time.time, notify=post_notice, report=aico_status.report,
                 remove=aico_status.remove, resolve=resolve_notice):
        self.cfg, self.now, self.notify, self.report, self.remove = cfg, now, notify, report, remove
        self.resolve = resolve
        self.folder = Path(cfg["state_dir"])
        self.folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.folder / "state.json"
        # An unreadable existing state must never become a fresh empty grant store.
        self.state = json.loads(path.read_text()) if path.exists() else {"requests": []}
        self.owner = pwd.getpwnam(cfg["owner"]).pw_uid

    def save(self) -> None:
        core.write_json(self.folder / "state.json", self.state, mode=0o600)

    def audit(self, event: str, req: dict[str, Any], uid: int) -> None:
        entry = {"at": self.now(), "event": event, "id": req["id"], "kind": req["grant"], "uid": uid}
        fd = os.open(self.folder / "uses.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a") as handle:
            handle.write(json.dumps(entry) + "\n")

    def refresh(self) -> None:
        now = self.now()
        for req in self.state["requests"]:
            if req["state"] in ("pending", "approved") and req["expires"] <= now:
                req["state"] = "expired"
            if req["state"] == "pending" and not req.get("pushed"):
                req["pushed"] = self.notify(self.cfg, req)
            if req["state"] not in ("pending", "approved"):
                req.setdefault("ended", min(now, req["expires"]))
            # Nothing is left to answer once it is not pending: its notice ends (retried until it does).
            if req["state"] != "pending" and req.get("pushed") and not req.get("resolved"):
                req["resolved"] = self.resolve(self.cfg, req)
        # A finished request stays a day for the record, then its row and entry go.
        old = [r for r in self.state["requests"] if "ended" in r and now - r["ended"] > FINISHED_KEEP_S]
        self.state["requests"] = [r for r in self.state["requests"] if r not in old]
        self.save()
        for r in old:
            self.remove(f"{aico_status.machine_id()}/grant-{r['id']}")
        rows = [{
            "id": f"{aico_status.machine_id()}/grant-{r['id']}", "what": r["title"], "kind": "grant",
            "machine": aico_status.machine_id(), "state": "ok" if r["state"] == "approved" else "off",
            "meaning": {"pending": "Waiting for your security key in the Aico tray.",
                        "approved": "Access is open until " + core.iso_time(r["expires"])}.get(r["state"], f"Access {r['state']}."),
            "last_run": core.iso_time(now), "next_run": core.iso_time(now + self.cfg["refresh_seconds"] * 2),
            "actions": [{"kind": "detail", "ref": self.cfg["public_url"]}],
        } for r in self.state["requests"]]
        if rows:
            self.report(rows)

    def public(self) -> dict[str, Any]:
        requests = [{k: v for k, v in req.items() if k != "challenge"} for req in self.state["requests"]]
        uses = []
        with contextlib.suppress(FileNotFoundError), (self.folder / "uses.jsonl").open() as handle:
            uses = [json.loads(line) for line in deque(handle, maxlen=200)]
        return {"public_url": self.cfg["public_url"], "requests": requests, "grants": [
            {"id": r["id"], "kind": r["grant"], "expires": r["expires"]}
            for r in requests if r["state"] == "approved"
        ], "uses": list(reversed(uses)), "labels": {k: v["label"] for k, v in self.cfg["kinds"].items()}}

    def request(self, msg: dict[str, Any], uid: int) -> dict[str, Any]:
        kind = msg.get("kind")
        if kind not in self.cfg["kinds"]:
            raise ValueError("unknown grant kind")
        reason = " ".join(str(msg.get("reason", "")).split())[:300]
        if not reason:
            raise ValueError("a reason is required")
        if kind == "github-admin" and re.search(r"check[ _-]?runs?\b|checks? api|commit status", reason, re.IGNORECASE):
            raise ValueError("Check-runs 403 uses the Actions fallback; it does not need GitHub admin.")
        minutes = msg.get("minutes", self.cfg["default_minutes"])
        if isinstance(minutes, bool) or not isinstance(minutes, int) or not 1 <= minutes <= self.cfg["max_minutes"]:
            raise ValueError("minutes outside the grant limit")
        now = self.now()
        req = {"id": secrets.token_hex(16), "kind": "elevate", "grant": kind, "reason": reason,
               "agent": " ".join(str(msg.get("requester", "agent")).split())[:80],
               "title": f"Open {self.cfg['kinds'][kind]['label']} for {minutes} min?",
               "created": now, "expires": now + self.cfg["request_seconds"], "minutes": minutes,
               "state": "pending", "challenge": secrets.token_hex(32), "pushed": False}
        self.state["requests"].append(req)
        self.save()
        self.audit("request", req, uid)
        return {"id": req["id"], "state": req["state"], "approve_url": f"{self.cfg['public_url']}?request={req['id']}"}

    def credentials(self) -> list[dict[str, Any]]:
        data = json.loads(Path(self.cfg["credentials_file"]).read_text())
        return data.get("credentials", [data] if data.get("public_key") else [])

    def ask(self, req: dict[str, Any]) -> dict[str, Any]:
        site = json.loads(Path(self.cfg["site_file"]).read_text())
        rp = site["approve_host"]
        return {"id": req["id"], "kind": "elevate", "title": req["title"], "lead": req["reason"],
                "details": [["Access", self.cfg["kinds"][req["grant"]]["what"]], ["Requested by", req["agent"]]],
                "state": req["state"], "label": req["state"].capitalize(), "text": "", "yes": "Approve",
                "final": req["state"] != "pending", "expires": req["expires"], "now": self.now(),
                "url": f"{self.cfg['public_url']}?request={req['id']}", "rp": rp,
                "origin": f"nightshift-desktop://{rp}",
                "creds": [cred["credential_id"] for cred in self.credentials()],
                "challenges": {d: hashlib.sha256(f"{req['challenge']}:{d}".encode()).hexdigest() for d in ("approve", "deny")}}

    def answer(self, req: dict[str, Any], msg: dict[str, Any]) -> None:
        decision, assertion = msg.get("decision"), msg.get("assertion", {})
        if req["state"] != "pending" or decision not in ("approve", "deny"):
            raise ValueError("this tap is no longer pending or the decision is invalid")
        shown = self.ask(req)
        creds = self.credentials()
        cred = next((c for c in creds if c["credential_id"] == assertion.get("credentialId")), None)
        if cred is None:
            raise ValueError("unknown security key")
        cred["sign_count"] = webauthn.verify(
            cred, webauthn.unb64url(assertion["authenticatorData"]), webauthn.unb64url(assertion["clientDataJSON"]),
            webauthn.unb64url(assertion["signature"]), bytes.fromhex(shown["challenges"][decision]), shown["origin"], shown["rp"])
        core.write_json(self.cfg["credentials_file"], {"v": 2, "credentials": creds}, mode=0o600)
        req["state"] = "approved" if decision == "approve" else "denied"
        if decision == "approve":
            req["expires"] = self.now() + req["minutes"] * 60

    def handle(self, msg: dict[str, Any], uid: int) -> dict[str, Any]:
        if uid not in (0, self.owner):
            raise ValueError("not allowed for this user")
        self.refresh()
        op = msg.get("op")
        if op in ("list", "open"):
            return self.public() if op == "list" else {"ids": [r["id"] for r in self.state["requests"] if r["state"] == "pending"]}
        if op == "request":
            out = self.request(msg, uid)
            self.refresh()
            return out
        selected = [r for r in self.state["requests"] if r["id"] == msg.get("id") or r["grant"] == msg.get("kind")]
        if op == "revoke":
            count = 0
            for req in selected:
                if req["state"] in ("pending", "approved"):
                    req["state"] = "revoked"
                    self.audit("revoke", req, uid)
                    count += 1
            self.refresh()
            return {"revoked": count}
        if not selected:
            raise ValueError("grant not found")
        req = selected[-1]
        if op == "ask":
            return self.ask(req)
        if op == "status":
            return {"state": req["state"], "expires": req["expires"]}
        if op == "answer":
            self.answer(req, msg)
            self.audit(req["state"], req, uid)
        elif op == "test-approve":
            if uid != 0 or req["grant"] != "test" or req["state"] != "pending":
                raise ValueError("root may approve only pending test access in a drill")
            req.update(state="approved", expires=self.now() + req["minutes"] * 60)
            self.audit("approved", req, uid)
        elif op == "use":
            live = [r for r in selected if r["state"] == "approved"]
            if not live:
                raise ValueError("no open grant")
            req = max(live, key=lambda r: r["expires"])
            env = self.cfg["kinds"][req["grant"]]["env"]
            token = None
            if env:
                path = Path(self.cfg["token_dir"]) / f"{req['grant']}.token"
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd) as handle:
                    st = os.fstat(handle.fileno())
                    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
                        raise ValueError("credential must be a root-owned private regular file")
                    token = handle.read(65536).strip()
                    if not token:
                        raise ValueError("credential file is empty")
            self.audit("use", req, uid)
            return {"id": req["id"], "open": True, "expires": req["expires"], "env": env, "token": token}
        else:
            raise ValueError("unknown operation")
        self.refresh()
        return {"code": 200, "state": req["state"], "expires": req["expires"]}


def serve() -> int:
    cfg = config()
    grants = Grants(cfg)

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            self.request.settimeout(5)
            try:
                _, uid, _ = struct.unpack("3i", self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                msg = json.loads(self.rfile.readline(16385))
                if not isinstance(msg, dict):
                    raise TypeError("expected an object")
                out = grants.handle(msg, uid)
            except (OSError, ValueError, KeyError, TypeError):
                out = {"error": "Grant request refused; check the request and whether access is still open."}
            self.wfile.write(json.dumps(out).encode() + b"\n")

    path = Path(cfg["socket"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    with socketserver.UnixStreamServer(str(path), Handler) as server:
        path.chmod(0o666)  # SO_PEERCRED authorizes callers; assertions authorize real approvals.
        server.timeout = cfg["refresh_seconds"]
        while True:
            server.handle_request()
            grants.refresh()
