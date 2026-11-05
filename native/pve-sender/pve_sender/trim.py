"""Weekly discard for running containers; no guest starts, disk changes or snapshot operations."""
from __future__ import annotations

import subprocess
import time
from pathlib import Path

from .state import read, write


def run(cfg: dict, *, run=None, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    execute = run or (lambda argv: subprocess.run(argv, capture_output=True, text=True, check=False))
    result = execute(["pct", "list"])
    trimmed, failed = [], []
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            fields = line.split()
            if len(fields) < 2 or not fields[0].isdigit() or fields[1] != "running":
                continue
            answer = execute(["pct", "fstrim", fields[0]])
            (trimmed if answer.returncode == 0 else failed).append(fields[0])
    value = {"at": now, "state": "ok" if result.returncode == 0 and not failed else "failed",
             "trimmed": trimmed, "failed": failed, "listed": result.returncode == 0}
    write(Path(cfg["state_dir"]) / "trim.json", value)
    return value


def status_row(cfg: dict, now: float) -> dict:
    from .watchdog import row

    result = read(Path(cfg["state_dir"]) / "trim.json", {})
    state = result.get("state", "warn")
    if not result.get("at"):
        meaning = "Weekly container trim has not run yet."
    else:
        age = max(0, now - result["at"])
        if state == "ok" and age > cfg.get("trim_interval_s", 7 * 24 * 3600) + cfg["slack_s"]:
            state = "warn"
        meaning = f"Last trim {int(age // 3600)}h ago: {len(result.get('trimmed', []))} containers trimmed."
        if not result.get("listed"):
            meaning += " The container list could not be read."
        if result.get("failed"):
            meaning += " Trim failed for " + ", ".join(result["failed"]) + "."
    value = row(cfg, "ct-trim", "Weekly container trim", state, meaning, now)
    value["kind"] = "job"
    value["actions"] = [{"kind": "log", "ref": "journalctl -u aico-pve-trim.service"}]
    return value
