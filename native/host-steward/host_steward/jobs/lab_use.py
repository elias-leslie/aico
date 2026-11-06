"""host-steward lab-use: say an agent session is using a parked lab machine, for how long and why.

`start ASSET --hours H --reason TEXT [--by NAME]`, `end ASSET`, `list`. The registry
check reads the file as a hint (a parked machine running under a current declaration is a note naming the session
instead of a warning). Nothing is granted; it ends by itself (at most 24 hours).
"""

from __future__ import annotations

import argparse
import json
import time
from collections.abc import Callable
from typing import Any

import aico_status
from host_steward import declare

NAME = "lab-use"
HELP = "say an agent session is using a parked lab machine (start, end or list)"


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("action", choices=("start", "end", "list"))
    parser.add_argument(
        "asset", nargs="?", default="", help="registry id (e.g. lab-linux-1) or PVE vmid"
    )
    parser.add_argument(
        "--hours", type=float, default=4.0, help="how long it is in use (default 4, at most 24)"
    )
    parser.add_argument("--reason", default="", help="what it is used for (shown on the board)")
    parser.add_argument(
        "--by", default="", help="who uses it (default: the session from the environment)"
    )


def main(
    args: argparse.Namespace, data: dict[str, Any], post: Callable[..., bool] = aico_status.report
) -> int:
    cfg = declare.settings(data)
    if args.action == "list":
        print(json.dumps(declare.lab_use(cfg), indent=1))
        return 0
    if not args.asset:
        print("asset required")
        return 2
    try:
        if args.action == "start":
            e = declare.start_lab_use(cfg, args.asset, args.hours, args.reason, args.by)
            print(
                f"declared {args.asset} until {time.strftime('%a %H:%M', time.localtime(e['until']))}"
            )
        else:
            print("ended" if declare.end_lab_use(cfg, args.asset) else "no declaration")
    except ValueError as error:
        print(error)
        return 2
    except OSError as error:
        print(f"could not write {cfg['lab_use_file']}: {error.strerror or error}")
        return 1
    return 0
