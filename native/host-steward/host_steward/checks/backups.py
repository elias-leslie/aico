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
    """Local native health stays local; offsite coverage reads each repository's own receipts."""
    result = ctx.run(ctx.cfg["aico_status_command"], timeout=ctx.cfg["status_timeout_s"])
    try:
        data = json.loads(result.out) if result.rc == 0 else None
    except ValueError:
        data = None
    entries = data.get("entries") if isinstance(data, dict) else None
    available = isinstance(entries, list) and bool(entries) and all(isinstance(e, dict) for e in entries)
    if not available:
        entries = []

    def copy_state(entry: dict[str, Any]) -> str:
        if entry.get("state") == "failed":
            return "failed"
        if any(not isinstance(entry.get(key), str) or not entry[key] for key in ("id", "source", "target")):
            return "warn"
        when = to_ts(entry.get("dataAt"))
        # A copy of a machine that was off stands as it is: off isn't behind.
        if entry.get("state") not in ("ok", "off") or when is None or when - ctx.now > ctx.cfg["future_skew_s"]:
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
    runs = data.get("runs") if isinstance(data, dict) else None

    def run_problems(target: str, max_age_h: float, owner_runs: Any = runs, machine: str = "Aico") -> list[tuple[str, str]]:
        latest = owner_runs.get(target) if isinstance(owner_runs, dict) else None
        label = "Drive" if target == "drive" else "native"
        if not isinstance(latest, dict):
            return [("warn", f"{machine}'s {label} run is unavailable")]
        started = to_ts(latest.get("started"))
        if latest.get("finished") is None and started is not None and -ctx.cfg["future_skew_s"] <= ctx.now - started <= max_age_h * 3600:
            # Running, or cut short by a shutdown before it could say how it went: not a failed run. The last
            # verified copies cover it, and their age below catches a run that never comes back.
            return []
        if latest.get("finished") is not None and latest.get("ok") is False:
            return [("failed", f"{machine}'s {label} run failed")]
        finished = to_ts(latest.get("finished"))
        if latest.get("ok") is not True or finished is None or ctx.now - finished > max_age_h * 3600 or finished - ctx.now > ctx.cfg["future_skew_s"]:
            return [("warn", f"{machine}'s {label} run has not finished lately")]
        return []

    def signal(code: str, issues: list[tuple[str, str]]) -> Signal:
        return Signal(code, "failed" if any(s == "failed" for s, _ in issues) else "warn",
                      {"why": "; ".join(why for _, why in issues[:3])}) if issues else Signal(code, "ok")

    fleet_result = ctx.run(ctx.cfg["fleet_status_command"], timeout=ctx.cfg["status_timeout_s"])
    try:
        fleet = json.loads(fleet_result.out) if fleet_result.rc == 0 else None
    except ValueError:
        fleet = None
    owners = fleet.get("owners") if isinstance(fleet, dict) else None
    valid_owners = isinstance(owners, list) and bool(owners) and all(
        isinstance(owner, dict) and isinstance(owner.get("machine"), str) and bool(owner["machine"])
        and isinstance(owner.get("repository"), str) and bool(owner["repository"])
        and isinstance(owner.get("sources"), list) and all(isinstance(s, str) for s in owner["sources"])
        and (owner.get("state") == "unknown" or (
            owner.get("state") == "read" and isinstance(owner.get("entries"), list)
            and isinstance(owner.get("retained"), list)
            and all(isinstance(e, dict) for e in owner["entries"] + owner["retained"])))
        for owner in owners)
    problems: list[tuple[str, str]] = []
    drive_problems: list[tuple[str, str]] = []
    if not valid_owners:
        problems.append(("warn", "Aico's fleet backup coverage is unavailable"))
        drive_problems.append(("warn", "Aico's backup owner runs are unavailable"))
    else:
        off: set[str] = set()
        if any(owner["state"] == "unknown" for owner in owners):
            # Status already combines verified machine power, intent and planned outages.
            # Only its shown machine state can distinguish deliberately off from unread here.
            machine_result = ctx.run(ctx.cfg["machine_status_command"], timeout=ctx.cfg["status_timeout_s"])
            try:
                machine_data = json.loads(machine_result.out) if machine_result.rc == 0 else None
            except ValueError:
                machine_data = None
            rows = machine_data.get("rows") if isinstance(machine_data, dict) else None
            if isinstance(rows, list):
                machine_rows = [row for row in rows if isinstance(row, dict) and row.get("kind") == "machine" and isinstance(row.get("machine"), str)]
                off = {row["machine"] for row in machine_rows if row.get("shown") == "off"}
                off -= {row["machine"] for row in machine_rows if row.get("shown") == "ok"}
        for owner in owners:
            if owner["state"] == "unknown":
                if owner["machine"] not in off:
                    drive_problems.append(("warn", f"{owner['machine']}: backup owner is unread"))
            else:
                drive_problems += run_problems("drive", ctx.cfg["drive_stale_hours"], owner.get("runs"), owner["machine"])
                drive_problems += [("failed", f"{owner['machine']}: {e.get('source', 'unknown')} copy failed")
                                   for e in owner["entries"] if e.get("state") == "failed"]
        for name in ctx.site["pve"]["backup_required_targets"]:
            assigned = [owner for owner in owners if name in owner["sources"]]
            matches = [e for owner in owners if owner["state"] == "read"
                       for e in owner["entries"] + owner["retained"]
                       if e.get("id") == f"drive/{name}" and e.get("source") == name and e.get("target") == "drive"]
            verified = [e for e in matches if isinstance(e.get("snapshot"), str) and bool(e["snapshot"])]
            # Distinct repositories may legitimately both hold this source during a handoff.
            if any(copy_state(e) == "ok" for e in verified):
                continue
            if not assigned or any(owner["state"] == "unknown" for owner in assigned):
                problems.append(("warn", f"{name}: backup owner coverage is unknown"))
            elif not verified:
                problems.append(("failed", f"{name}: no verified offsite snapshot"))
            else:
                state = "failed" if any(copy_state(e) == "failed" for e in verified) else "warn"
                problems.append((state, f"{name}: copy is {state}"))
    native_problems: list[tuple[str, str]] = []
    for name in ctx.cfg["native_required_sources"]:
        matches = [e for e in entries if e.get("id") == f"native/{name}" and e.get("source") == name and e.get("target") == "native"]
        if len(matches) != 1:
            native_problems.append(("failed", f"{name}: recovery point is missing or ambiguous"))
            continue
        entry = matches[0]
        state = copy_state(entry)
        when = to_ts(entry.get("dataAt"))
        if entry.get("state") == "off":
            continue  # the T7 is unplugged: its age doesn't count until it is back
        if when is not None and ctx.now - when > ctx.cfg["native_failed_hours"] * 3600:
            state = "failed"
        elif when is not None and ctx.now - when > ctx.cfg["native_warn_hours"] * 3600 and state == "ok":
            state = "warn"
        if state != "ok":
            native_problems.append((state, f"{name}: recovery point is {state}"))
        if not isinstance(entry.get("snapshot"), str) or not entry["snapshot"] or not isinstance(entry.get("path"), str) or not entry["path"].startswith("/"):
            native_problems.append(("failed", f"{name}: no verified received recovery point"))
    required = {f"native/{name}" for name in ctx.cfg["native_required_sources"]}
    if not any(e.get("id") in required and e.get("state") == "off" for e in entries):
        native_problems += run_problems("native", ctx.cfg["native_failed_hours"])
    native = signal("backups.native", native_problems) if available else Signal("backups.native", "warn", {"why": "Aico's local backup health is unavailable"})
    return [source, signal("backups.pve", problems), signal("backups.drive", drive_problems), native]


def run(ctx: Ctx) -> list[Signal]:
    owner = ctx.site["owner"]["user"]
    try:
        pw = pwd.getpwnam(owner)
    except KeyError:
        return [Signal("backups.owner", "warn", {"owner": owner})]
    return (aico_backups(ctx) + autosnap(ctx, pw.pw_dir)
            + job_health(ctx, "drill", "backups.drill", "restore drill"))
