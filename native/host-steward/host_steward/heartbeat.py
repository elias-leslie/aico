"""Independent root heartbeat; CT 190 also runs this through its existing push-only SSH key."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

import aico_status

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def payload(status: dict, cfg: dict) -> dict:
    rows = status.get("rows", [])
    floor = [r for r in rows if r.get("id") in cfg["floor_ids"]]
    return {"v": 1, "source": "aico", "kind": "heartbeat",
            "floor_failed": any(r.get("state") == "failed" or r.get("shown") in ("failed", "late") for r in floor)}


def sync_route(cfg: dict, execute) -> bool:
    if not cfg.get("route"):
        return True
    try:
        route = cfg["route"]
        account = json.loads(Path(route["account"]).read_text())
        devices = json.loads(Path(route["devices"]).read_text())
        if not isinstance(devices, list):
            raise TypeError("Phone registry must be a list.")
        if any(not isinstance(dev, dict) for dev in devices):
            raise TypeError("Phone registry contains an invalid entry.")
        # Minimal projection: pairing signing keys never leave the phone registry.
        phones = [{key: dev[key] for key in ("fcm_token", "enc_pub", "auth")}
                  for dev in devices if dev.get("fcm_token") and not dev.get("token_gone")
                  and dev.get("enc_pub") and dev.get("auth")]
        wire = {"fcm": {"service_account": account, "devices": phones, "base": route["base"]}}
        token = json.loads(Path(route["token"]).read_text())
        wire["token_cache"] = {**token, "key_id": account.get("private_key_id")}
        sync_cmd = cfg["ssh"][:-3] + cfg["sync_command"]
        synced = execute(sync_cmd, input=json.dumps(wire), text=True,
                         capture_output=True, timeout=cfg["timeout_s"], check=False)
        return synced.returncode == 0 and json.loads(synced.stdout).get("synced") is True
    except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
        return False


def run(cfg: dict, *, execute=subprocess.run, post=aico_status.report) -> int:
    now = datetime.now(UTC)
    health_ok = True
    try:
        with OPENER.open(cfg["status_url"], timeout=5) as response:
            status = json.load(response)
        if not isinstance(status.get("rows"), list):
            raise TypeError("No status rows.")
        data = payload(status, cfg)
    except (OSError, ValueError, TypeError, AttributeError):
        health_ok = False
        data = {"v": 1, "source": "aico", "kind": "heartbeat", "floor_failed": True}
    # CT's heartbeat proves Aico responds; a running host alone does not refresh that heartbeat.
    if cfg["source"] == "ct190" and not health_ok:
        return 1
    try:
        route_ok = sync_route(cfg, execute)
        result = execute(cfg["ssh"], input=json.dumps(data), text=True,
                         capture_output=True, timeout=cfg["timeout_s"], check=False)
        answer = json.loads(result.stdout) if result.returncode == 0 else {}
        ok = answer.get("heartbeat") == cfg["source"] and route_ok
        if cfg["source"] == "workstation":
            sender_age = answer.get("sender_age")
            ok = ok and isinstance(sender_age, int | float) and 0 <= sender_age <= cfg["sender_stale_s"]
    except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
        ok, answer = False, {}
    rows = answer.get("rows", [])
    rows.append({"id": aico_status.machine_id() + "/pve-heartbeat", "what": "Proxmox heartbeat link",
                 "kind": "link", "machine": aico_status.machine_id(), "state": "ok" if ok else "failed",
                 "meaning": "Proxmox received this machine's heartbeat." if ok else "Proxmox did not accept the heartbeat. Check the sender service and SSH link.",
                 "last_run": now, "next_run": now + timedelta(seconds=cfg["every_s"] + cfg["slack_s"]),
                 "actions": [{"kind": "log", "ref": "journalctl -u host-steward-heartbeat.service"}]})
    post(rows, url=cfg["post_url"])
    return 0 if ok else 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("data") / "heartbeat.json")
    args = parser.parse_args(argv)
    return run(json.loads(args.config.read_text()))


if __name__ == "__main__":
    sys.exit(main())
