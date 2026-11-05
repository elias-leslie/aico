"""Backup health from Aico entries/jobs and the still-live native capture helper.

Aico computes copy age and offline-unchanged coverage on each API read. Historical SummitFlow
receipts are retained as evidence, never treated as a live health source.
"""

from __future__ import annotations

import json
import os
import pwd
import stat
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


def read_json(path: str, owner_uid: int | None = None) -> tuple[os.stat_result, Any]:
    """A regular, non-symlink JSON file, at most 4 MB; owned by owner_uid when given."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, encoding="utf-8") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("not a regular file")
        if owner_uid is not None and info.st_uid != owner_uid:
            raise ValueError("not owned by the backup owner")
        return info, json.loads(handle.read(4_000_000))


def native_host(ctx: Ctx, home: str, uid: int) -> list[Signal]:
    cfg = ctx.cfg
    if not os.path.exists(cfg["native_config"]):
        return []
    root = f"{home}/.local/state/summitflow/host-recovery"
    try:
        _, latest = read_json(f"{root}/latest.json", uid)
        _, good = read_json(f"{root}/last-good.json", uid)
    except (OSError, ValueError):
        return [Signal("backups.native", "warn", {"why": "the host backup receipt is unreadable"})]
    problems: list[tuple[str, str]] = []
    status = latest.get("status")
    if status in ("failed", "cancelled", "blocked"):
        problems.append(("failed", f"the latest capture {status}"))
    elif status == "partial" or latest.get("reason"):
        problems.append(("warn", "the latest capture is incomplete"))
    elif status not in ("completed", "running"):
        problems.append(("warn", f"the latest capture status is {status}"))
    if (
        good.get("point_availability") == "expired"
        or good.get("status") != "completed"
        or good.get("capture_complete") is not True
        or good.get("artifacts_complete") is not True
        or not good.get("points")
    ):
        problems.append(("failed", "the last good capture has no usable recovery points"))
    captured = to_ts(good.get("finished_at") or good.get("started_at"))
    age_h = (ctx.now - captured) / 3600 if captured else None
    if age_h is None:
        problems.append(("warn", "the last good capture time is unreadable"))
    elif age_h > cfg["native_failed_hours"]:
        problems.append(("failed", f"the last good capture is {age_h:.0f} h old"))
    elif age_h > cfg["native_warn_hours"]:
        problems.append(("warn", f"the last good capture is {age_h:.0f} h old"))
    if not problems:
        return [Signal("backups.native", "ok", {"hours": f"{age_h:.0f}"})]
    worst = max(problems, key=lambda p: p[0] == "failed")
    return [Signal("backups.native", worst[0], {"why": "; ".join(p[1] for p in problems)})]


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
                for code in ["backups.sources", "backups.pve"]]

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
    drive = runs.get("drive") if isinstance(runs, dict) else None
    if not isinstance(drive, dict):
        problems.append(("warn", "Aico's Drive run is unavailable"))
    elif drive.get("ok") is False:
        problems.append(("failed", "Aico's Drive run failed"))
    else:
        finished = to_ts(drive.get("finished"))
        if drive.get("ok") is not True or finished is None or ctx.now - finished > ctx.cfg["drive_stale_hours"] * 3600 or finished - ctx.now > ctx.cfg["future_skew_s"]:
            problems.append(("warn", "Aico's Drive run has not finished lately"))
    pve = Signal("backups.pve", "failed" if any(s == "failed" for s, _ in problems) else "warn",
                 {"why": "; ".join(why for _, why in problems[:3])}) if problems else Signal("backups.pve", "ok")
    return [source, pve]


def run(ctx: Ctx) -> list[Signal]:
    owner = ctx.site["owner"]["user"]
    try:
        pw = pwd.getpwnam(owner)
    except KeyError:
        return [Signal("backups.owner", "warn", {"owner": owner})]
    return (aico_backups(ctx) + native_host(ctx, pw.pw_dir, pw.pw_uid) + autosnap(ctx, pw.pw_dir)
            + job_health(ctx, "drill", "backups.drill", "restore drill"))
