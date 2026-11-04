"""host-steward declare: say a change a check watches is yours (so its row shows a note, not a problem).

Port of `nightshift declare`. `host-steward declare --host HOST --what KIND --hours N --reason TEXT [--since H]`
records the declaration (host_steward/declare.py has the rules); `host-steward declare list` shows them, open ones
first. Nothing is granted and no row is posted: the checks read the file.
"""

from __future__ import annotations

import argparse
import json
import time
from collections.abc import Callable
from typing import Any

import aico_status
from host_steward import declare

NAME = "declare"
HELP = "say an agent is changing something the host checks watch (listeners, units, vm, firewall, packages, keys, config)"


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "action",
        nargs="?",
        choices=("add", "list"),
        default="add",
        help="add (the default): declare a change, with --host, --what and --reason; list: show the declarations, open ones first",
    )
    parser.add_argument(
        "--host", default="", help="host name from the board, or a role: workstation, pve, router"
    )
    parser.add_argument(
        "--what", default="", help=f"what you change: {', '.join(declare.KINDS)} (lab-use = vm)"
    )
    parser.add_argument(
        "--hours",
        type=float,
        default=2.0,
        help="how long changes may keep coming (default 2, at most 24)",
    )
    parser.add_argument(
        "--since",
        type=float,
        default=0.0,
        help="hours ago the change started, for one already made (at most 4)",
    )
    parser.add_argument("--reason", default="", help="what you change and why (shown on the board)")
    parser.add_argument(
        "--by", default="", help="who (default: the agent session running this command)"
    )
    parser.add_argument("--json", action="store_true", help="list: print the raw entries as JSON")


def when(at: float) -> str:
    return time.strftime("%a %H:%M", time.localtime(at))


def main(
    args: argparse.Namespace, data: dict[str, Any], post: Callable[..., bool] = aico_status.report
) -> int:
    cfg = declare.settings(data)
    if args.action == "list":
        rows = declare.declarations(cfg, track=False)
        if args.json:
            print(json.dumps(rows, indent=1))
            return 0
        now = time.time()
        for e in sorted(
            rows, key=lambda e: (e["until"] <= now, -e["until"])
        ):  # open ones first, newest first
            state = (
                f"open until {when(e['until'])}"
                if e["until"] > now
                else f"ended {when(e['until'])}"
            )
            print(f"{state}: {e['what']} on {e['host']} by {e['by']}: {e['reason']}")
        print(
            f"{sum(e['until'] > now for e in rows)} open; ended ones stay listed {int(cfg['retain_h'])} h "
            "so rows from their window stay explained"
        )
        return 0
    try:
        e = declare.declare(
            cfg, data["site"], args.host, args.what, args.hours, args.reason, args.since, args.by
        )
    except ValueError as error:
        print(error)
        return 2
    except OSError as error:
        print(f"could not write {cfg['file']}: {error.strerror or error}")
        return 1
    print(f"declared {e['what']} on {e['host']} by {e['by']} until {when(e['until'])}")
    return 0
