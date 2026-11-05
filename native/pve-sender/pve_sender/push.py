"""The existing push-only SSH callers, with their validation and persistent deduplication."""
from __future__ import annotations

import json
import re
import secrets
import time
from pathlib import Path

from . import sender
from .state import read, write

MAX_STDIN = 8192


def validate(text: str, caller: dict) -> dict:
    if len(text.encode()) > MAX_STDIN:
        raise ValueError("Notice is too long.")
    notice = json.loads(text)
    if not isinstance(notice, dict) or notice.get("v") != 1 or notice.get("source") != caller["source"]:
        raise ValueError("Wrong notice version or source.")
    if notice.get("kind") not in caller["kinds"] or notice.get("severity") not in caller["severities"]:
        raise ValueError("Kind or severity is not allowed.")
    for field in ("title", "body"):
        value = notice.get(field)
        if not isinstance(value, str) or not 1 <= len(value) <= caller[field + "_max"] or not value.isprintable():
            raise ValueError("Title or body is not plain text within its limit.")
    if not isinstance(notice.get("key"), str) or re.fullmatch(caller["key"], notice["key"]) is None:
        raise ValueError("Bad notice key.")
    link = notice.get("open")
    if "open" in notice and (not isinstance(link, str) or len(link) > 300 or not link.isascii()
                             or re.fullmatch(re.escape(caller["origin"]) + caller["path"], link) is None):
        raise ValueError("Open link is outside the caller's origin.")
    return notice


def heartbeat(cfg: dict, source: str, data: dict, now: float) -> dict:
    if source not in cfg["sources"]:
        raise ValueError("Unknown heartbeat source.")
    path = Path(cfg["state_dir"]) / "heartbeats.json"
    current = read(path, {})
    current[source] = {"at": now, "floor_failed": data.get("floor_failed") is True}
    write(path, current)
    return {"heartbeat": source, "at": now}


def push(cfg: dict, name: str, text: str, *, now=None, send=None) -> dict:
    now = time.time() if now is None else now
    caller = cfg["callers"].get(name)
    if caller is None:
        raise ValueError("Unknown caller.")
    raw = json.loads(text)
    # The existing Aico CT key stays push-only. It can refresh only its own named heartbeat.
    if name == "aico" and isinstance(raw, dict) and raw.get("v") == 1 and raw.get("source") == "aico" and raw.get("kind") == "heartbeat":
        return heartbeat(cfg, "ct190", raw, now)
    notice = validate(text, caller)
    key = caller["log_prefix"] + notice["key"]
    path = Path(cfg["state_dir"]) / "receipts.json"
    receipts = read(path, {})
    previous = receipts.get(key)
    window = caller["dedupe_s"]
    if previous is not None and (window is None or now - previous < window):
        return {"ok": True, "result": "Already sent."}
    pending_path = Path(cfg["state_dir"]) / "pending-notices.json"
    pending = read(pending_path, {})
    delivery_id = pending.setdefault(key, secrets.token_hex(12))
    write(pending_path, pending)
    notice = {**notice, "key": key, "delivery_id": delivery_id}
    if caller["tray_silent"] and notice.get("push") == "tray":
        notice["severity"] = "info"
    result = (send or (lambda message: sender.send(cfg, message, now)))(notice)
    if result["ok"]:
        receipts[key] = now
        write(path, receipts)
        pending.pop(key, None)
        write(pending_path, pending)
    return result
