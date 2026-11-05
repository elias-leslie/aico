"""Backups: SummitFlow's status files, its freshness receipts, the host capture and project snapshots, the PVE receipt.

Port of ns/checks/backups.py plus the PVE receipt rule (ns/executor/backup.py evaluate, for the PVE backup age).
Left out: the circuit-breaker wording per file (any failing entry fails the file the same way) and the receipt
path hardening beyond "regular file, no symlink, owned by the backup owner".
"""

from __future__ import annotations

import glob
import json
import os
import pwd
import re
import stat
from datetime import UTC, datetime
from fnmatch import fnmatchcase
from typing import Any

from host_steward.core import Ctx, Signal

ID = "backups"
FAIL = {"failed", "failure", "fail", "error", "errored", "broken", "refused", "refusing", "tripped", "open", "blocked", "critical", "unhealthy", "mismatch", "corrupt"}
TS_KEYS = ("completed_at", "generated_at", "checked_at", "updated_at", "finished_at", "at", "timestamp", "last_run_at")
STATE_KEYS = ("status", "state", "result", "verdict", "breaker", "circuit")
NESTED = ("sources", "checks", "targets", "repositories", "repos", "results", "steps", "items")
HEADROOM = re.compile(r"headroom|scratch space|disk space|free space|low disk|no space|reserve", re.IGNORECASE)
FREQUENCY_S = {"hourly": 3600, "four_hourly": 4 * 3600, "daily": 86400, "weekly": 7 * 86400, "monthly": 30 * 86400}


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


def state_of(d: dict[str, Any]) -> str:
    for key in STATE_KEYS:
        value = d.get(key)
        if isinstance(value, str):
            return value.strip().lower()
        if isinstance(value, dict) and (inner := state_of(value)):
            return inner
    return ""


def failing(d: Any, depth: int = 0) -> list[str]:
    """Names of failing entries: this dict (ok false / failing state) and nested sources / checks / targets."""
    if not isinstance(d, dict) or depth > 3:
        return []
    out: list[str] = []
    if d.get("ok") is False or d.get("passed") is False or d.get("success") is False or state_of(d) in FAIL:
        out.append(str(d.get("name") or d.get("id") or d.get("target") or state_of(d) or "status"))
    for key in NESTED:
        value = d.get(key)
        items = list(value.items()) if isinstance(value, dict) else list(enumerate(value)) if isinstance(value, list) else []
        for name, item in items:
            if failing(item, depth + 1):
                label = item.get("name") or item.get("id") or name if isinstance(item, dict) else name
                out.append(str(label))
    return list(dict.fromkeys(out))


def stale_hours(path: str, table: dict[str, float]) -> float:
    for pattern, hours in sorted(table.items(), key=lambda kv: kv[0] == "*"):
        if fnmatchcase(os.path.basename(path), pattern):
            return float(hours)
    return 8 * 24.0


def slug(path: str) -> str:
    parent, name = os.path.split(path)
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", f"{os.path.basename(parent)}.{os.path.splitext(name)[0]}")[:80]


def status_files(ctx: Ctx, home: str) -> list[Signal]:
    cfg = ctx.cfg
    base = f"{home}/.local/state/summitflow"
    expected = [p if p.startswith("/") else f"{base}/{p}" for p in cfg["expected"]]
    paths = [p for p in expected if os.path.lexists(p)]
    out = [Signal("backups.file.missing", "warn", {"file": slug(p)}) for p in expected if not os.path.lexists(p)]
    for pattern in cfg["status_globs"]:
        paths += [p for p in sorted(glob.glob(f"{base}/{pattern}")) if p not in paths and os.path.isfile(p)]
    for path in paths[: int(cfg["max_files"])]:
        try:
            info, data = read_json(path)
        except (OSError, ValueError):
            out.append(Signal("backups.file.unreadable", "warn", {"file": slug(path)}))
            continue
        if not isinstance(data, dict):
            out.append(Signal("backups.file.unreadable", "warn", {"file": slug(path)}))
            continue
        when = next((t for k in TS_KEYS if (t := to_ts(data.get(k)))), info.st_mtime)
        age_h = (ctx.now - when) / 3600
        fails = failing(data)
        limit = stale_hours(path, cfg["stale_hours"])
        if fails:
            out.append(Signal("backups.file.failed", "failed", {"file": slug(path), "what": ", ".join(fails[:4])}))
        elif age_h > limit:
            out.append(Signal("backups.file.stale", "warn", {"file": slug(path), "days": f"{age_h / 24:.1f}"}))
        else:
            out.append(Signal("backups.file", "ok", {"file": slug(path)}))
    return out


def frequency_s(value: Any) -> float:
    if isinstance(value, int | float) and not isinstance(value, bool) and value > 0:
        return float(value)
    text = str(value or "").strip().lower()
    if text in FREQUENCY_S:
        return float(FREQUENCY_S[text])
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([mhd])", text)
    return float(m.group(1)) * {"m": 60, "h": 3600, "d": 86400}[m.group(2)] if m else 86400.0


def freshness(ctx: Ctx, home: str) -> list[Signal]:
    cfg = ctx.cfg
    path = f"{home}/.local/state/summitflow/{cfg['sources_receipt']}"
    if not os.path.lexists(path):
        return []
    try:
        info, data = read_json(path)
    except (OSError, ValueError):
        return [Signal("backups.sources.unreadable", "warn")]
    if not isinstance(data, dict):
        return [Signal("backups.sources.unreadable", "warn")]
    out: list[Signal] = []
    age_h = (ctx.now - (to_ts(data.get("generated_at")) or info.st_mtime)) / 3600
    if age_h > cfg["receipt_stale_hours"]:
        out.append(Signal("backups.sources.stale", "warn", {"hours": f"{age_h:.0f}"}))
    factor = float(cfg["source_fail_factor"])
    headroom, other = [], []
    sources = data.get("sources")
    for sid, src in (sources.items() if isinstance(sources, dict) else []):
        if not isinstance(src, dict) or src.get("ok") is not False:
            continue
        last = to_ts(src.get("last_success_at"))
        if last is not None and ctx.now - last <= factor * frequency_s(src.get("frequency")):
            continue
        error = " ".join(str(src.get("last_error") or "").split())[:160]
        (headroom if HEADROOM.search(error) else other).append(str(sid)[:80])
    since = to_ts(data.get("capture_refused_since"))
    if since is not None or headroom:
        hours = (ctx.now - since) / 3600 if since is not None else 0.0
        state = "failed" if headroom or hours >= cfg["refused_failed_hours"] else "warn"
        out.append(Signal("backups.capture.refused", state, {"hours": f"{hours:.1f}", "sources": ", ".join(headroom[:4]) or "none named"}))
    else:
        out.append(Signal("backups.capture.refused", "ok"))
    if other:
        out.append(Signal("backups.sources.failing", "failed", {"n": len(other), "sources": ", ".join(other[:4])}))
    else:
        out.append(Signal("backups.sources.failing", "ok"))
    return out


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


def autosnap(ctx: Ctx, home: str) -> list[Signal]:
    """The Aico scheduler owns project snapshots; old sweep receipts are historical only."""
    result = ctx.run(ctx.cfg["snapshot_status_command"], timeout=ctx.cfg["snapshot_status_timeout_s"])
    try:
        data = json.loads(result.out) if result.rc == 0 else None
        rows = data.get("rows", []) if isinstance(data, dict) else []
        row = next((r for r in rows if isinstance(r, dict) and r.get("id") == ctx.cfg["snapshot_job_id"]), None)
    except (ValueError, TypeError):
        row = None
    if row is None:
        return [Signal("backups.autosnap", "warn", {"why": "Aico's snapshot job status is unavailable"})]
    state = row.get("state")
    if state == "failed":
        return [Signal("backups.autosnap", "failed", {"why": "Aico's snapshot job failed"})]
    when = to_ts(row.get("last_run"))
    if when is None or ctx.now - when > ctx.cfg["snapshot_stale_hours"] * 3600:
        return [Signal("backups.autosnap", "warn", {"why": "Aico's snapshot job has not run lately"})]
    if state != "ok" or row.get("shown") in {"late", "unknown"}:
        return [Signal("backups.autosnap", "warn", {"why": "Aico's snapshot job is not healthy"})]
    return [Signal("backups.autosnap", "ok")]


def target_problem(t: dict[str, Any], max_age_h: float, elapsed_h: float) -> str:
    if t.get("fresh") is not True or t.get("status") not in ("fresh", "offline-unchanged"):
        return f"status {t.get('status')}"
    if to_ts(t.get("verified_at")) is None:
        return "not verified"
    if t.get("offsite") != "verified":
        return f"offsite {t.get('offsite')}"
    if t.get("restore_test_ok") is False:
        return "restore test failed"
    age = t.get("age_hours")
    if t.get("status") == "fresh":
        if isinstance(age, bool) or not isinstance(age, int | float) or age < 0:
            return "age unknown"
        if age + elapsed_h > max_age_h:
            return f"age {age + elapsed_h:.0f} h"
    return ""


def pve_receipt(ctx: Ctx, uid: int) -> Signal:
    """The PVE backup freshness receipt: written lately, ok, every required target fresh and verified offsite."""
    pve = ctx.site["pve"]
    try:
        _, data = read_json(pve["backup_receipt"], uid)
    except (OSError, ValueError):
        return Signal("backups.pve", "warn", {"why": "the receipt is missing or unreadable"})
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        return Signal("backups.pve", "warn", {"why": "the receipt has an unknown format"})
    generated = to_ts(data.get("generated_at"))
    if generated is None:
        return Signal("backups.pve", "warn", {"why": "the receipt has no time"})
    age_h = (ctx.now - generated) / 3600
    if age_h > pve["backup_alert_age_h"] or generated - ctx.now > 600:
        return Signal("backups.pve", "failed", {"why": f"the receipt writer stopped {age_h:.0f} h ago"})
    max_age = float(data.get("max_age_hours") or 36)
    by_name = {}
    for t in data.get("targets") or []:
        if isinstance(t, dict):
            by_name[str(t.get("target"))] = t
            if t.get("source_id"):
                by_name[str(t["source_id"])] = t
    reasons = []
    if data.get("ok") is not True:
        reasons.append("the receipt says not ok")
    for name in pve["backup_required_targets"]:
        t = by_name.get(name)
        why = "missing from the receipt" if t is None else target_problem(t, max_age, max(0.0, age_h))
        if why:
            reasons.append(f"{name}: {why}")
    if reasons:
        return Signal("backups.pve", "failed", {"why": "; ".join(reasons[:3])})
    return Signal("backups.pve", "ok", {"hours": f"{age_h:.1f}"})


def run(ctx: Ctx) -> list[Signal]:
    owner = ctx.site["owner"]["user"]
    try:
        pw = pwd.getpwnam(owner)
    except KeyError:
        return [Signal("backups.owner", "warn", {"owner": owner})]
    out = status_files(ctx, pw.pw_dir) + freshness(ctx, pw.pw_dir) + native_host(ctx, pw.pw_dir, pw.pw_uid)
    out += autosnap(ctx, pw.pw_dir)
    out.append(pve_receipt(ctx, pw.pw_uid))
    return out
