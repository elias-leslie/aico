"""One FCM message, using the existing root-only phone route and token cache."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

from . import fcm
from .state import read, write

# Which row of Aico's Settings > Notifications each key this sender sees belongs to; first match wins.
# Off-host messages have no door, so the owner's phone switches reach here through sync-credentials.
NOTICE_TYPES = {
    "pve-sender:test": "tests",
    "pve-sender:": "outage",
    "portfolio-ai:": "portfolio",
    "aico:ask:": "agent-question",
    "aico:digest:": "digest",
    "aico:test": "tests",
    "aico:pushcheck:": "tests",
}


def phone_off(cfg: dict, notice: dict) -> bool:
    """The owner keeps this notice's type off the phone in Aico's Settings. A key the table doesn't name
    files under its sender, as at Aico's door, so nothing passes a switch by being unknown."""
    off = read(Path(cfg["state_dir"]) / "phone-off.json", {}).get("phone_off", [])
    if str(notice.get("title", "")).lower().startswith("test"):
        return "tests" in off
    for prefix, notice_type in cfg.get("notice_types", NOTICE_TYPES).items():
        if notice["key"].startswith(prefix):
            return notice_type in off
    return f"source:{notice.get('source') or notice['key'].split(':')[0]}" in off


def route_status(cfg: dict) -> dict:
    """Operational metadata only; never return device identifiers, keys or tokens."""
    route = (read(Path(cfg["credentials"]), {}) or {}).get("fcm") or {}
    cache = read(Path(cfg["token_cache"]), {})
    return {"devices": sum(bool(d.get("fcm_token")) and not bool(d.get("token_gone"))
                           for d in route.get("devices", []) if isinstance(d, dict)),
            "token_expires_at": cache.get("expires_at"), "token_minted_at": cache.get("minted_at")}


def _route(cfg: dict) -> tuple[dict, list, dict]:
    route = (read(Path(cfg["credentials"]), {}) or {}).get("fcm") or {}
    devices = [d for d in route.get("devices", []) if d.get("fcm_token") and not d.get("token_gone")]
    return route, devices, route.get("service_account") or {}


def send(cfg: dict, notice: dict, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    if phone_off(cfg, notice):
        return {"ok": True, "accepted": 0, "devices": 0, "silenced": True, "result": "Silenced in Aico's Settings."}
    route = _route(cfg)[0]
    delivery_id = notice.get("delivery_id") or hashlib.sha256(json.dumps(notice, sort_keys=True).encode()).hexdigest()
    severity = notice["severity"]
    item = {
        "v": 1, "id": delivery_id, "title": notice["title"], "body": notice["body"],
        "detail": notice.get("detail", "Sent by Aico on Proxmox."), "severity": severity,
        "channel": severity if severity in ("critical", "warning") else "info",
        "tag": notice["key"], "group": "aico", "kind": notice.get("kind", "info"),
        "ts": int(now), "url": route.get("base", "") + "/", "actions": [],
        "public": "Aico: critical alert" if severity == "critical" else "Aico update",
    }
    if notice.get("open"):
        item["actions"] = [{"id": "open", "label": "Open", "tier": "view", "url": notice["open"]}]
    return deliver(cfg, item, delivery_id, now)


def deliver(cfg: dict, item: dict, delivery_id: str, now: float | None = None) -> dict:
    """Sends one finished app item to every paired phone, each phone at most once per delivery id."""
    now = time.time() if now is None else now
    _, devices, account = _route(cfg)
    if not devices or not account.get("project_id"):
        return {"ok": False, "result": "No paired phone route on Proxmox."}
    cache_path = Path(cfg["token_cache"])
    cache = read(cache_path, {})
    severity = item["severity"]
    try:
        if (cache.get("key_id") != account.get("private_key_id")
                or float(cache.get("expires_at", 0)) - now <= 300):
            token, expires = fcm.mint(account, now)
            cache = {"access_token": token, "expires_at": expires, "key_id": account.get("private_key_id")}
            write(cache_path, cache)
        token = cache["access_token"]
        receipts_path = Path(cfg["state_dir"]) / "device-receipts.json"
        receipts = read(receipts_path, {})
        event = receipts.setdefault(delivery_id, {})
        plain = json.dumps(item, ensure_ascii=False).encode()
        # The encrypted record and its base64 must fit FCM's 4096-byte data limit.
        if len(plain) > 2900:
            return {"ok": False, "result": "Phone message is too long."}
        codes = []
        for device in devices:
            device_id = hashlib.sha256(device["fcm_token"].encode()).hexdigest()
            code = event.get(device_id)
            if code is None:
                code = fcm.fcm_push(device, plain, severity, account["project_id"], token)
                if 200 <= code < 300 or code in (404, 410):
                    event[device_id] = code
                    write(receipts_path, receipts)
            codes.append(code)
        if 401 in codes:
            cache_path.unlink(missing_ok=True)
    except Exception as error:  # noqa: BLE001 -- cryptographic and HTTP failures may include credentials
        # Never echo an exception's text: HTTP requests and key parsers may contain secrets.
        return {"ok": False, "result": f"Phone sender failed ({type(error).__name__})."}
    accepted = sum(200 <= c < 300 for c in codes)
    return {"ok": accepted == len(devices), "accepted": accepted, "devices": len(devices), "message_id": delivery_id,
            "result": f"FCM accepted {accepted}/{len(devices)}; HTTP {','.join(map(str, codes))}."}
