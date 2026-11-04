"""host-steward nvme-test short|long: start the NVMe SMART self-test, as Nightshift's units do.

Nightshift's nightshift-nvme-{short,long}-test.service run `smartctl -t short|long /dev/nvme0`. The calendars are
the timers in systemd/ (short Saturdays 03:00, long the first Saturday 00:30), installed but not enabled until
cutover. With [acting] nvme_tests off it only says "would run: ..." and posts a "Dry run" row that also carries the
latest real self-test result (smartctl -l selftest). The test runs inside the drive; its result shows in the
disk-tests row once it is done.
"""

from __future__ import annotations

import argparse
import json
import time
from typing import Any

import aico_status
from host_steward import acts, core
from host_steward.checks.disk_tests import POWER_ON, ago_text, latest_selftest

NAME = "nvme-test"
HELP = "start an NVMe SMART self-test, short or long (dry run until [acting] nvme_tests is on)"


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("kind", help="short or long, a name in [jobs.nvme-test.kinds]")
    parser.add_argument(
        "--no-post", action="store_true", help="print the result, post no Status row"
    )


def last_result(actor: acts.Actor, device: str) -> str:
    log = actor.run(["smartctl", "-l", "selftest", device], timeout=60).out
    latest = latest_selftest(log)
    if latest is None:
        return "no earlier self-test result"
    found = POWER_ON.search(actor.run(["smartctl", "-A", device], timeout=60).out)
    when = ago_text(latest["hours"], found.group(1) if found else None)
    return f"last self-test {latest['kind']}, {latest['status'].lower()}, {when}"


def main(args: argparse.Namespace, data: dict[str, Any], post: Any = aico_status.report) -> int:
    cfg = data["jobs"][NAME]
    if args.kind not in cfg["kinds"]:
        print(
            f"host-steward nvme-test: no such kind: {args.kind} (have: {', '.join(cfg['kinds'])})"
        )
        return 2
    kind, now = cfg["kinds"][args.kind], time.time()
    device = cfg["device"]
    actor = acts.Actor(core.acting(data, "nvme_tests"), run=core.run_command)
    argv = [cfg["smartctl"], "-t", args.kind, device]
    result = actor.do(argv, label=f"run: {' '.join(argv)}", timeout=60)
    summary = last_result(actor, device)
    if result is None:
        state, meaning = (
            "ok",
            f"Dry run: would start a {args.kind} self-test on {device}; {summary}. Nightshift's timer still runs it.",
        )
    elif result.rc == 0:
        state, meaning = "ok", f"Started a {args.kind} self-test on {device}; {summary}."
    else:
        state, meaning = (
            "warn",
            f"The {args.kind} self-test on {device} did not start (exit {result.rc}); {summary}.",
        )
    name = f"nvme-{args.kind}-test"
    row = core.job_row(
        name,
        kind["what"],
        state,
        meaning,
        aico_status.machine_id(),
        now,
        kind["every_min"],
        kind["slack_min"],
        actions=[
            {"kind": "run", "ref": f"host-steward nvme-test {args.kind}"},
            {"kind": "log", "ref": f"journalctl -u host-steward-{name}.service"},
        ],
    )
    if not args.no_post:
        post(row)
    print(
        json.dumps(
            {
                "live": actor.live,
                "kind": args.kind,
                "state": state,
                "meaning": meaning,
                "would": actor.would,
            },
            sort_keys=True,
        )
    )
    return 0 if state == "ok" else 1
