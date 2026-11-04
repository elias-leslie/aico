"""Btrfs scrubs and NVMe self-tests: what the last real ones found, read-only.

New for host-steward (Nightshift ran the scrub and self-test timers but kept no row of their results beyond the
storage check's failed-self-test rule). Reads `btrfs scrub status` for each configured disk and `smartctl -l
selftest` for the NVMe drive, so the scheduled jobs have live information even before they run here. The schedule
follows [acting] (the runner's ctx.acting): while scrub or nvme_tests is off the row says that schedule is still
Nightshift's; once on, it is host-steward's timers ([checks.disk-tests] timers), and one that is not enabled warns,
since nothing else would run it. The parsers are shared with the scrub and nvme-test jobs.
"""

from __future__ import annotations

import re
from typing import Any

from host_steward.checks.storage import SELFTEST_FAILED
from host_steward.core import Ctx, Signal

ID = "disk-tests"
POWER_ON = re.compile(r"Power On Hours:\s*([\d,]+)", re.IGNORECASE)


def parse_scrub(text: str) -> dict[str, str]:
    """`btrfs scrub status` -> started, status, duration, errors (the error summary line)."""
    keys = {
        "Scrub started": "started",
        "Status": "status",
        "Duration": "duration",
        "Error summary": "errors",
    }
    out: dict[str, str] = {}
    for line in text.splitlines():
        name, _, rest = line.strip().partition(":")
        if name in keys:
            out[keys[name]] = rest.strip()
    if "no stats available" in text and "status" not in out:
        out["status"] = "no stats available"
    return out


def scrub_state(info: dict[str, str]) -> str:
    """failed: the scrub found errors; warn: it did not finish (aborted, interrupted, never ran); else ok."""
    if not info.get("errors", "no errors found").startswith("no errors"):
        return "failed"
    return "ok" if info.get("status") in ("running", "finished") else "warn"


def latest_selftest(text: str) -> dict[str, str] | None:
    """The newest entry of `smartctl -l selftest` (NVMe numbers it 0, ATA '# 1'): kind, status, power-on hours."""
    for line in text.splitlines():
        if not re.match(r"^\s*(?:#\s*)?[01]\s+\S", line):
            continue
        parts = re.split(r"\s{2,}", line.strip())
        if len(parts) < 3:
            continue
        hours = next((p for p in parts[3:] if p.isdigit()), "")
        return {
            "kind": parts[1],
            "status": parts[2],
            "hours": hours,
            "failed": "yes" if SELFTEST_FAILED.search(line) else "",
        }
    return None


def ago_text(test_hours: str, now_hours: str | None) -> str:
    try:
        delta = int(now_hours.replace(",", "")) - int(test_hours) if now_hours else None
    except ValueError:
        delta = None
    if delta is None or delta < 0:
        return "at an unknown time"
    return f"{delta} h ago" if delta < 48 else f"{delta // 24} days ago"


def short_date(text: str) -> str:
    """'Sun Nov  1 08:04:44 2026' -> 'Nov 1'."""
    match = re.match(r"^\w{3}\s+(\w{3})\s+(\d+)", text.strip())
    return f"{match.group(1)} {match.group(2)}" if match else (text or "?")


def scrub_signal(ctx: Ctx, entry: dict[str, Any]) -> Signal:
    name, mount = entry["name"], entry["mount"]
    result = ctx.run(["btrfs", "scrub", "status", mount], timeout=30)
    if result.rc != 0 and not result.out:
        return Signal("disk_tests.scrub.unreadable", "warn", {"name": name, "mount": mount})
    info = parse_scrub(result.out)
    if not info:
        return Signal("disk_tests.scrub.unreadable", "warn", {"name": name, "mount": mount})
    state = scrub_state(info)
    fields = {
        "name": name,
        "status": info.get("status", "?"),
        "started": short_date(info.get("started", "")),
        "errors": info.get("errors", "?"),
    }
    return Signal("disk_tests.scrub", state, fields)


def selftest_signal(ctx: Ctx) -> Signal:
    device = ctx.cfg["nvme_device"]
    result = ctx.run(["smartctl", "-l", "selftest", device], timeout=60)
    if (
        result.rc not in (0, 4) or "Self-test" not in result.out
    ):  # bit 2 (4): a log entry reports a past failure
        return Signal("disk_tests.selftest.unreadable", "warn", {"device": device})
    latest = latest_selftest(result.out)
    if latest is None:
        return Signal("disk_tests.selftest.none", "ok", {"device": device}, note=True)
    now_hours = None
    health = ctx.run(["smartctl", "-A", device], timeout=60).out
    if match := POWER_ON.search(health):
        now_hours = match.group(1)
    fields = {**latest, "device": device, "when": ago_text(latest["hours"], now_hours)}
    return Signal("disk_tests.selftest", "failed" if latest["failed"] else "ok", fields)


def last_results(signals: list[Signal]) -> str:
    """One line of the last real results, for the row while nothing is wrong."""
    parts = []
    for signal in signals:
        fields = signal.fields
        if signal.code == "disk_tests.scrub":
            parts.append(
                f"{fields['name']} scrub {fields['status']} {fields['started']}, {fields['errors']}"
            )
        elif signal.code == "disk_tests.selftest":
            parts.append(
                f"NVMe self-test {fields['kind']}, {str(fields['status']).lower()}, {fields['when']}"
            )
    return "; ".join(parts) or "no earlier results"


def run(ctx: Ctx) -> list[Signal]:
    signals = [scrub_signal(ctx, entry) for entry in ctx.cfg["scrubs"]]
    signals.append(selftest_signal(ctx))
    signals.append(Signal("disk_tests.last", "ok", {"text": last_results(signals)}, note=True))
    return signals + schedule_signals(ctx)


def schedule_signals(ctx: Ctx) -> list[Signal]:
    """Whose schedule runs each kind: Nightshift's while its [acting] switch is off (a note); host-steward's timers
    once on, each of which must be enabled (systemctl is-enabled) or the row warns."""
    nightshift = [kind for kind in ctx.cfg["timers"] if not ctx.acting.get(kind)]
    out = []
    if nightshift:
        code = "disk_tests.dry_run" + ("" if len(nightshift) > 1 else f".{nightshift[0]}")
        out.append(Signal(code, "ok", {}, note=True))
    off = [
        timer
        for kind, timers in ctx.cfg["timers"].items()
        if ctx.acting.get(kind)
        for timer in timers
        if ctx.run(["systemctl", "--no-ask-password", "is-enabled", timer], timeout=30).rc != 0
    ]
    if off:
        out.append(Signal("disk_tests.timer_off", "warn", {"timers": " ".join(off)}))
    return out
