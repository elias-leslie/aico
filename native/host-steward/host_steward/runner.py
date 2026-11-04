"""host-steward check [--only NAME ...] [--dry-run]: run the due checks, post their rows in one batch (the other
commands are the modules in host_steward/jobs).

A check is due when it never ran or its every_min (minus a minute of timer jitter) has passed; --only runs the
named checks whether due or not. A check that raises becomes a failed row ("check.crashed"), never a missing one.
Rows go to Aico's Status API over loopback (aico_status.report, which never raises); a refused batch leaves the
checks' last_run unset so the next timer run retries them. State (baselines, last runs) is one JSON file.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import aico_status
from host_steward import core, telemetry
from host_steward.checks import CHECKS
from host_steward.jobs import JOBS

log = logging.getLogger("host-steward")
JITTER_S = 60


def is_due(check: str, cfg: Mapping[str, Any], state: Mapping[str, Any], now: float) -> bool:
    last = state.get("last_run", {}).get(check)
    return (
        not isinstance(last, int | float) or now - last >= float(cfg["every_min"]) * 60 - JITTER_S
    )


def run_checks(
    data: Mapping[str, Any],
    state: dict[str, Any],
    now: float,
    only: Sequence[str] = (),
    run: core.Runner = core.run_command,
    machine: str | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """(rows, the checks that made them). `state` is updated in place; last_run is the caller's to set."""
    machine = machine or aico_status.machine_id()
    cache: dict[str, Any] = {}
    rows, ran = [], []
    for check, module in CHECKS.items():
        cfg = data["checks"][check]
        if (only and check not in only) or (not only and not is_due(check, cfg, state, now)):
            continue
        ctx = core.Ctx(
            cfg=cfg,
            site=data["site"],
            now=now,
            run=run,
            state=state.setdefault("checks", {}).setdefault(check, {}),
            cache=cache,
            acting=data.get("acting", {}),
        )
        try:
            signals = module.run(ctx)
        except Exception as error:  # one broken check must still show up as a failed row
            log.exception("check %s crashed", check)
            signals = [
                core.Signal(
                    "check.crashed", "failed", {"check": check, "why": type(error).__name__}
                )
            ]
        rows.append(
            core.make_row(check, signals, cfg, data["meanings"], machine, now, data["caps"])
        )
        ran.append(check)
    return rows, ran


def main(argv: Sequence[str] | None = None, post: Callable[..., bool] = aico_status.report) -> int:
    parser = argparse.ArgumentParser(prog="host-steward")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="run the due host checks and post their Status rows")
    check.add_argument(
        "--only", action="append", default=[], metavar="NAME", help="run this check now"
    )
    check.add_argument(
        "--dry-run", action="store_true", help="print the rows, post nothing, keep no state"
    )
    for job in JOBS.values():
        job.add_args(sub.add_parser(job.NAME, help=job.HELP))
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    data = core.load_data()
    if args.command in JOBS:
        with telemetry.run(args.command):
            return JOBS[args.command].main(args, data, post)
    if args.dry_run:
        return check_command(args, data, post)
    with telemetry.run("check"):
        return check_command(args, data, post)


def check_command(args: argparse.Namespace, data: dict[str, Any], post: Callable[..., bool]) -> int:
    unknown = sorted(set(args.only) - set(CHECKS))
    if unknown:
        print(
            f"host-steward: no such check: {', '.join(unknown)} (have: {', '.join(CHECKS)})",
            file=sys.stderr,
        )
        return 2
    state = core.load_state()
    now = time.time()
    rows, ran = run_checks(data, state, now, args.only)
    if args.dry_run:
        print(json.dumps(rows, indent=1, default=str))
        return 0
    posted = bool(rows) and post(rows)
    if posted:
        state.setdefault("last_run", {}).update({name: now for name in ran})
    core.save_state(state)
    print(
        f"host-steward: ran {', '.join(ran) or 'nothing (none due)'}; rows {'posted' if posted else 'not posted'}"
    )
    return 0 if posted or not rows else 1
