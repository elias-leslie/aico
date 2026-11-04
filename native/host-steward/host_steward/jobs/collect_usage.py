"""host-steward collect-usage: the nightly 30-day usage evidence collection (read-only on the host, additive).

Port of `nightshift collect-usage`: system and user unit timestamps, a /proc process sample and process accounting
go into the usage sqlite file; nothing is ever pruned. Posts the job's Status row.
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import aico_status
from host_steward import core, usage

NAME = "collect-usage"
HELP = "collect the 30-day usage evidence (units, processes, process accounting) and post its row"
log = logging.getLogger("host-steward")


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--dry-run", action="store_true", help="print the row instead of posting it"
    )


def build_row(
    data: dict[str, Any], now: float, result: dict[str, Any] | None, why: str = ""
) -> dict[str, Any]:
    cfg = data["checks"]["usage"]
    meanings = data["meanings"]
    if result is None:
        state, code, fields = "failed", "usage.collect_failed", {"why": why}
    else:
        counts = result["counts"]
        fields = {"records": sum(counts.values()), "sources": len(counts)}
        state, code = (
            ("ok", "usage.collected") if result["acct_ok"] else ("warn", "usage.acct_unavailable")
        )
    return core.job_row(
        NAME, cfg["job_what"], state, core.explain(code, fields, meanings, True, state),
        aico_status.machine_id(), now, float(cfg["job_every_min"]), float(cfg["job_slack_min"]),
        actions=[
            {"kind": "run", "ref": "host-steward collect-usage"},
            {"kind": "log", "ref": "journalctl -u host-steward-collect-usage.service"},
        ],
    )  # fmt: skip


def main(
    args: argparse.Namespace, data: dict[str, Any], post: Callable[..., bool] = aico_status.report
) -> int:
    cfg = data["checks"]["usage"]
    now = time.time()
    try:
        result = usage.collect(
            cfg, data["site"]["owner"]["user"], Path(cfg["db"]), datetime.fromtimestamp(now, UTC)
        )
        row = build_row(data, now, result)
    except Exception as error:  # a broken collection is a failed row, not a missing one
        log.exception("collect-usage failed")
        row = build_row(data, now, None, type(error).__name__)
    if args.dry_run:
        print(json.dumps(row, indent=1, default=str))
        return 0
    return 0 if post([row]) else 1
