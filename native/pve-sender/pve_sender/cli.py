"""Root entry points. Successful heartbeat replies carry only public status rows."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from . import push, sender, trim, watchdog
from .state import locked, read, write


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="pve-sender")
    parser.add_argument("--config", default=os.environ.get("AICO_PVE_CONFIG", "/etc/aico/pve-sender.json"))
    sub = parser.add_subparsers(dest="command", required=True)
    tick = sub.add_parser("tick")
    tick.add_argument("--test", action="store_true", help="test label; use only with a separate scratch config")
    sub.add_parser("status")
    sub.add_parser("trim", help="Return unused blocks from running containers")
    sub.add_parser("sync-credentials")
    beat = sub.add_parser("heartbeat")
    beat.add_argument("source")
    guest = sub.add_parser("push")
    guest.add_argument("caller", nargs="?", default="aico")
    args = parser.parse_args(argv)
    try:
        cfg = read(Path(args.config))
        directory = Path(cfg["state_dir"])
        text = ""
        lock_directory = directory
        if args.command in ("heartbeat", "push", "sync-credentials"):
            limit = 262144 if args.command == "sync-credentials" else push.MAX_STDIN
            text = sys.stdin.read(limit + 1)
            if len(text.encode()) > limit:
                raise ValueError("Input is too long.")
            data = json.loads(text)
            if args.command == "heartbeat" or (args.command == "push" and args.caller == "aico"
                    and isinstance(data, dict) and data.get("kind") == "heartbeat"):
                lock_directory = directory / "heartbeat-lock"
            elif args.command == "sync-credentials":
                lock_directory = directory / "credentials-lock"
        elif args.command == "trim":
            # fstrim can run for minutes; the watchdog tick must never wait behind it.
            lock_directory = directory / "trim-lock"
        with locked(lock_directory):
            if args.command == "trim":
                result = trim.run(cfg)
                print(json.dumps(result))
                return 0 if result["state"] == "ok" else 1
            if args.command == "sync-credentials":
                route = data.get("fcm", {})
                if not isinstance(route.get("devices"), list) or not isinstance(route.get("service_account"), dict):
                    raise ValueError("Invalid phone route.")
                # Root-to-root stdin transfer only; this is never part of heartbeat/status replies.
                write(Path(cfg["credentials"]), {"fcm": route})
                # The owner's phone switches (Aico Settings); absent when Aico couldn't be read: keep the last.
                off = data.get("phone_off")
                if isinstance(off, list) and all(isinstance(item, str) for item in off):
                    write(directory / "phone-off.json", {"phone_off": off})
                token = data.get("token_cache", {})
                if token.get("access_token") and token.get("expires_at", 0) > time.time():
                    write(Path(cfg["token_cache"]), token)
                print(json.dumps({"synced": True, "devices": len(route["devices"]),
                                  "token_expires_at": token.get("expires_at")}))
                return 0
            if args.command == "tick":
                if args.test and not cfg.get("test_mode"):
                    raise ValueError("Test ticks require a scratch test_mode configuration.")
                status = watchdog.tick(cfg, test=args.test, publish=not args.test)
                print(json.dumps({k: v for k, v in status.items() if k != "rows"}))
                return 0 if status.get("last_send", {}).get("ok", True) else 1
            if args.command == "status":
                print(json.dumps({**read(directory / "status.json", {}), "route": sender.route_status(cfg)}))
                return 0
            if args.command == "heartbeat":
                if not isinstance(data, dict):
                    raise ValueError("Heartbeat must be an object.")
                answer = push.heartbeat(cfg, args.source, data, time.time())
                status = read(directory / "status.json", {})
                answer["rows"] = status.get("rows", [])
                answer["sender_age"] = time.time() - status["at"] if "at" in status else None
                print(json.dumps(answer))
                return 0
            result = push.push(cfg, args.caller, text)
            print(json.dumps(result))
            return 0 if result.get("ok", "heartbeat" in result) else 75
    except (ValueError, TypeError, KeyError) as error:
        print(f"pve-sender refused input ({type(error).__name__}).", file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001 -- CLI must never print a secret-bearing exception
        print(f"pve-sender failed ({type(error).__name__}); see configuration and service status.", file=sys.stderr)
        return 1
