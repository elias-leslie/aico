"""Root mints the short-lived FCM token; the key and token never appear in output."""
from __future__ import annotations

import argparse
import json
import os
import pwd
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import aico_status
from host_steward import core, fcm_wire


def refresh(cfg: dict, *, now=None, force=False, mint=fcm_wire.mint, post=aico_status.report) -> int:
    now = time.time() if now is None else now
    target = Path(cfg["token"])
    cached = core.load_state(target)
    ok = True
    meaning = "The phone sender's access token is current."
    try:
        try:
            fresh = bool(cached.get("access_token")) and float(cached.get("expires_at", 0)) - now > cfg["refresh_before_s"]
        except (TypeError, ValueError):
            fresh = False
        if force or not fresh:
            account = json.loads(Path(cfg["account"]).read_text())
            token, expires = mint(account, now)
            gid = pwd.getpwnam(cfg["owner"]).pw_gid
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
            os.chown(target.parent, 0, gid)
            os.chmod(target.parent, 0o750)
            core.write_json(target, {"access_token": token, "expires_at": expires, "minted_at": now,
                                     "project_id": account["project_id"]}, mode=0o640, group=cfg["owner"])
    except Exception as error:  # noqa: BLE001 -- never emit account/token or provider exception text
        ok = False
        meaning = f"Could not refresh the phone sender's access token ({type(error).__name__})."
    at = datetime.fromtimestamp(now, UTC)
    post({"id": aico_status.machine_id() + "/fcm-token", "what": "Phone sender access token",
          "kind": "service", "machine": aico_status.machine_id(), "state": "ok" if ok else "failed",
          "meaning": meaning, "last_run": at, "next_run": at + timedelta(seconds=cfg["every_s"] + cfg["slack_s"]),
          "actions": [{"kind": "log", "ref": "journalctl -u host-steward-fcm-token.service"}]})
    print("Phone sender access token is current." if ok else meaning)
    return 0 if ok else 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("data") / "fcm-token.json")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    return refresh(json.loads(args.config.read_text()), force=args.force)


if __name__ == "__main__":
    raise SystemExit(main())
