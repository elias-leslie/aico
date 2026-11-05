"""Backup health from Aico entries/jobs and their current copy metadata.

Aico computes copy age and offline-unchanged coverage on each API read. Historical SummitFlow
receipts are retained as evidence, never treated as a live health source.
"""

from __future__ import annotations

import json
import pwd
from datetime import UTC, datetime
from typing import Any

from host_steward.core import Ctx, Signal

ID = "backups"

def to_ts(value: Any) -> float | None:
    if isinstance(value, int | float) and not isinstance(value, bool) and value > 1e9:
        return float(value)
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value)
        except ValueError:
            return None
        return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).timestamp()
    return None


def job_health(ctx: Ctx, prefix: str, signal: str, name: str) -> list[Signal]:
    result = ctx.run(ctx.cfg[f"{prefix}_status_command"], timeout=ctx.cfg["status_timeout_s"])
    try:
        data = json.loads(result.out) if result.rc == 0 else None
        rows = data.get("rows", []) if isinstance(data, dict) else []
        row = next((r for r in rows if isinstance(r, dict) and r.get("id") == ctx.cfg[f"{prefix}_job_id"]), None)
    except (ValueError, TypeError):
        row = None
    why = ""
    state = "warn"
    if row is None:
        why = f"Aico's {name} job status is unavailable"
    elif row.get("state") == "failed":
        why, state = f"Aico's {name} job failed", "failed"
    else:
        when = to_ts(row.get("last_run"))
        if when is None or ctx.now - when > ctx.cfg[f"{prefix}_stale_hours"] * 3600 or when - ctx.now > ctx.cfg["future_skew_s"]:
            why = f"Aico's {name} job has not run lately"
        elif row.get("state") != "ok" or row.get("shown") in {"late", "unknown"}:
            why = f"Aico's {name} job is not healthy"
        else:
            return [Signal(signal, "ok")]
    return [Signal(signal, state, {"why": why})]


def autosnap(ctx: Ctx, home: str) -> list[Signal]:
    return job_health(ctx, "snapshot", "backups.autosnap", "snapshot")


def aico_backups(ctx: Ctx) -> list[Signal]:
    """Read the owning live view; require actual offsite snapshot metadata for every required PVE source."""
    result = ctx.run(ctx.cfg["aico_status_command"], timeout=ctx.cfg["status_timeout_s"])
    try:
        data = json.loads(result.out) if result.rc == 0 else None
    except ValueError:
        data = None
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(data, dict) or not isinstance(entries, list) or not entries or any(not isinstance(e, dict) for e in entries):
        return [Signal(code, "warn", {"why": "Aico's backup health is unavailable"})
                for code in ["backups.sources", "backups.pve", "backups.native"]]

    def copy_state(entry: dict[str, Any]) -> str:
        if entry.get("state") == "failed":
            return "failed"
        if any(not isinstance(entry.get(key), str) or not entry[key] for key in ("id", "source", "target")):
            return "warn"
        when = to_ts(entry.get("dataAt"))
        if entry.get("state") != "ok" or when is None or when - ctx.now > ctx.cfg["future_skew_s"]:
            return "warn"
        # The API recomputes age with its owning per-target policy and offlineSince state on every GET.
        # Do not reinterpret UI wording or call an old, unchanged offline copy stale here.
        return "ok"

    issues = [(copy_state(e), str(e.get("id") or "unknown")[:80])
              for e in entries if e.get("state") != "off" and copy_state(e) != "ok"]
    if not any(e.get("state") != "off" for e in entries):
        issues.append(("warn", "no active sources"))
    source = Signal("backups.sources", "failed" if any(s == "failed" for s, _ in issues) else "warn",
                    {"why": ", ".join(label for _, label in issues[:4])}) if issues else Signal("backups.sources", "ok")
    problems: list[tuple[str, str]] = []
    for name in ctx.site["pve"]["backup_required_targets"]:
        matches = [e for e in entries if e.get("id") == f"drive/{name}" and e.get("source") == name and e.get("target") == "drive"]
        if len(matches) != 1:
            problems.append(("failed", f"{name}: offsite copy is missing or ambiguous"))
            continue
        entry = matches[0]
        state = copy_state(entry)
        if state != "ok":
            problems.append((state, f"{name}: copy is {state}"))
        if not isinstance(entry.get("snapshot"), str) or not entry["snapshot"]:
            problems.append(("failed", f"{name}: no verified offsite snapshot"))
    runs = data.get("runs")

    def run_problems(target: str, max_age_h: float) -> list[tuple[str, str]]:
        latest = runs.get(target) if isinstance(runs, dict) else None
        label = "Drive" if target == "drive" else "native"
        if not isinstance(latest, dict):
            return [("warn", f"Aico's {label} run is unavailable")]
        started = to_ts(latest.get("started"))
        running = any(e.get("target") == target and e.get("running") is True for e in entries)
        if latest.get("finished") is None and running and started is not None and -ctx.cfg["future_skew_s"] <= ctx.now - started <= max_age_h * 3600:
            return []  # A live lease plus the last verified copies covers an in-progress run.
        if latest.get("ok") is False:
            return [("failed", f"Aico's {label} run failed")]
        finished = to_ts(latest.get("finished"))
        if latest.get("ok") is not True or finished is None or ctx.now - finished > max_age_h * 3600 or finished - ctx.now > ctx.cfg["future_skew_s"]:
            return [("warn", f"Aico's {label} run has not finished lately")]
        return []

    def signal(code: str, issues: list[tuple[str, str]]) -> Signal:
        return Signal(code, "failed" if any(s == "failed" for s, _ in issues) else "warn",
                      {"why": "; ".join(why for _, why in issues[:3])}) if issues else Signal(code, "ok")

    problems += run_problems("drive", ctx.cfg["drive_stale_hours"])
    native_problems: list[tuple[str, str]] = []
    for name in ctx.cfg["native_required_sources"]:
        matches = [e for e in entries if e.get("id") == f"native/{name}" and e.get("source") == name and e.get("target") == "native"]
        if len(matches) != 1:
            native_problems.append(("failed", f"{name}: recovery point is missing or ambiguous"))
            continue
        entry = matches[0]
        state = copy_state(entry)
        when = to_ts(entry.get("dataAt"))
        if when is not None and ctx.now - when > ctx.cfg["native_failed_hours"] * 3600:
            state = "failed"
        elif when is not None and ctx.now - when > ctx.cfg["native_warn_hours"] * 3600 and state == "ok":
            state = "warn"
        if state != "ok":
            native_problems.append((state, f"{name}: recovery point is {state}"))
        if not isinstance(entry.get("snapshot"), str) or not entry["snapshot"] or not isinstance(entry.get("path"), str) or not entry["path"].startswith("/"):
            native_problems.append(("failed", f"{name}: no verified received recovery point"))
    native_problems += run_problems("native", ctx.cfg["native_failed_hours"])
    return [source, signal("backups.pve", problems), signal("backups.native", native_problems)]


def run(ctx: Ctx) -> list[Signal]:
    owner = ctx.site["owner"]["user"]
    try:
        pw = pwd.getpwnam(owner)
    except KeyError:
        return [Signal("backups.owner", "warn", {"owner": owner})]
    return (aico_backups(ctx) + autosnap(ctx, pw.pw_dir)
            + job_health(ctx, "drill", "backups.drill", "restore drill"))
