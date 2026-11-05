"""CLI for the root grant socket. Credential replies go only into a child environment."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

from host_steward.grants import call, config


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="aico grants")
    sub = parser.add_subparsers(dest="op", required=True)
    request = sub.add_parser("request", help="ask for a tray security-key tap")
    request.add_argument("kind")
    request.add_argument("--reason", required=True)
    request.add_argument("--minutes", type=int, default=config()["default_minutes"])
    request.add_argument("--requester", default=os.environ.get("AICO_SESSION_ID", "agent"))
    request.add_argument("--wait", action="store_true")
    sub.add_parser("list", aliases=["status"], help="requests, open grants and uses")
    revoke = sub.add_parser("revoke", help="end a request or a kind of access now")
    revoke.add_argument("kind")
    active = sub.add_parser("active", help="check and log a use of permission-only access")
    active.add_argument("kind")
    active.add_argument("--json", action="store_true")
    run = sub.add_parser("run", help="hand the credential only to one child command")
    run.add_argument("kind")
    run.add_argument("cmd", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        if args.op in ("list", "status"):
            out = call({"op": "list"})
        elif args.op == "request":
            out = call({"op": "request", "kind": args.kind, "reason": args.reason,
                        "minutes": args.minutes, "requester": args.requester})
            print(json.dumps(out), flush=True)
            if not args.wait:
                return 0
            rid = out["id"]
            while True:
                out = call({"op": "status", "id": rid})
                if out["state"] != "pending":
                    print(json.dumps(out))
                    return 0 if out["state"] == "approved" else 3
                time.sleep(2)
        elif args.op == "revoke":
            out = call({"op": "revoke", "kind": args.kind, "id": args.kind})
        elif args.op == "active":
            # Metadata-only: never request a credential for an active check.
            listed = call({"op": "list"})
            grant = next((g for g in listed["grants"] if g["kind"] == args.kind), None)
            if grant and not config()["kinds"][args.kind]["env"]:
                call({"op": "use", "id": grant["id"]})
            out = {"kind": args.kind, "open": grant is not None, "expires": grant["expires"] if grant else None,
                   "id": grant["id"] if grant else None}
            print(json.dumps(out))
            return 0 if grant else 3
        else:
            cmd = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
            if not cmd or not config()["kinds"].get(args.kind, {}).get("env"):
                raise ValueError("run needs a credential kind and a command; permission-only access uses active")
            out = call({"op": "use", "kind": args.kind})
            env = dict(os.environ)
            env.update({name: out["token"] for name in out["env"]})
            return subprocess.run(cmd, env=env, check=False).returncode
        print(json.dumps(out))
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(f"aico grants: {error}", file=sys.stderr)
        return 3
