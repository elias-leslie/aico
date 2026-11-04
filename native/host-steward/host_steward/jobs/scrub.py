"""host-steward scrub --target native|root: the monthly Btrfs scrub, as Nightshift's units run it.

Same command and the same lock file as nightshift-btrfs-scrub-*.service: `flock LOCK [wrap...] btrfs scrub
start -Bd -c 3 MOUNT`, where the backup disk's scrub runs inside SummitFlow's backup window. The calendars are the
timers in systemd/ (Sun 01..07 for the system disk, Sun 15..21 for the backup disk, 08:00), which install-root.sh
enables while [acting] scrub is on. With it off it only says "would run: ..." and posts a "Dry run" row that also
carries the last real result (btrfs scrub status). --status posts the row for the schedule and last result and
starts nothing (install-root.sh runs it, so the row follows the switch at once rather than at the next timer).
"""

from __future__ import annotations

import argparse
import fcntl
import json
import time
from pathlib import Path
from typing import Any

import aico_status
from host_steward import acts, core
from host_steward.checks.disk_tests import parse_scrub

NAME = "scrub"
HELP = "monthly Btrfs scrub of one disk (dry run until [acting] scrub is on)"


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--target", required=True, help="which disk, a name in [jobs.scrub.targets] (native, root)"
    )
    parser.add_argument(
        "--no-post", action="store_true", help="print the result, post no Status row"
    )
    parser.add_argument(
        "--status", action="store_true", help="post the row (schedule, last result), scrub nothing"
    )


def last_result(actor: acts.Actor, mount: str) -> str:
    info = parse_scrub(actor.run(["btrfs", "scrub", "status", mount], timeout=30).out)
    if not info:
        return "no earlier scrub result"
    errors = info.get("errors", "")
    return f"last scrub {info.get('status', '?')} ({info.get('started', '?')}), {errors or 'no error line'}"


def run_scrub(
    cfg: dict[str, Any], target: dict[str, Any], actor: acts.Actor
) -> tuple[str, str, dict[str, Any]]:
    """(state, meaning, detail). Live holds the shared lock while the scrub runs."""
    mount = target["mount"]
    argv = [*target.get("wrap", []), cfg["btrfs"], *cfg["args"], mount]
    command = " ".join(argv)
    if not actor.live:
        actor.would.append(f"run: {command}")
        text = f"Dry run: would scrub {mount}; {last_result(actor, mount)}. Nightshift's timer still runs it."
        return "ok", text, {"would": list(actor.would)}
    lock = Path(cfg["lock"])
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)  # waits, as flock(1) does
        result = actor.do(argv, timeout=float(target["timeout_s"]))
    assert result is not None
    summary = last_result(actor, mount)
    if result.rc == 0:
        return "ok", f"Scrubbed {mount}: {summary}.", {"rc": 0}
    return (
        "warn",
        f"The scrub of {mount} ended with exit {result.rc}; {summary}.",
        {"rc": result.rc},
    )


def main(args: argparse.Namespace, data: dict[str, Any], post: Any = aico_status.report) -> int:
    cfg = data["jobs"][NAME]
    targets = cfg["targets"]
    if args.target not in targets:
        print(f"host-steward scrub: no such target: {args.target} (have: {', '.join(targets)})")
        return 2
    target, now = targets[args.target], time.time()
    actor = acts.Actor(core.acting(data, "scrub"), run=core.run_command)
    if actor.live and (why := core.refusal(data, "scrub", core.run_command)):
        actor.live = False  # stands down: no scrub, no look at the disk, just the warning
        state, meaning, detail = "warn", why, {"refused": True}
    elif getattr(args, "status", False) and actor.live:
        actor.live = False  # the timer runs it; this only says so
        meaning = f"Runs on host-steward's timer; {last_result(actor, target['mount'])}."
        state, detail = "ok", {"status": True}
    else:
        state, meaning, detail = run_scrub(cfg, target, actor)
    name = f"scrub-{args.target}"
    row = core.job_row(
        name,
        target["what"],
        state,
        meaning,
        aico_status.machine_id(),
        now,
        target["every_min"],
        target["slack_min"],
        actions=[
            {"kind": "log", "ref": f"journalctl -u host-steward-{name}.service -n 200 --no-pager"},
        ],
    )
    if not args.no_post:
        post(row)
    print(
        json.dumps(
            {
                "live": actor.live,
                "target": args.target,
                "state": state,
                "meaning": meaning,
                **detail,
            },
            sort_keys=True,
        )
    )
    return 0 if state == "ok" else 1
