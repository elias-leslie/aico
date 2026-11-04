"""Trend evaluation over the metric history (history.py), one verdict vocabulary for every trend.

Port of ns/trend.py on daily values. A Spec groups the rules behind one trend signal. Each rule reads one metric:

  rate        event count per day: the last 7 days vs the 23 before (until 14 days are covered, the covered span is
              split in half)
  any         any event within the hold window is worsening (uncorrected memory errors)
  counter     monotonic counter per dimension (SMART media errors): an increase inside the hold window is worsening
  level       gauge per dimension: recent mean vs prior mean
  projection  gauge with a limit per dimension (pool or disk percent): days until the limit at the current slope

Verdicts: insufficient (not enough history), stable, improving, worsening (with reasons). A rule only says
"worsening" once enough history backs it; before that a rising value reads as insufficient with a note.
"""

from __future__ import annotations

import statistics
from collections.abc import Callable, Mapping
from dataclasses import dataclass, fields
from datetime import date, timedelta
from typing import Any

from host_steward.history import Store

DAY = 86400
RANK = {"worsening": 0, "improving": 2, "stable": 3, "insufficient": 4}


@dataclass(frozen=True)
class Rule:
    metric: str
    kind: str  # rate | any | counter | level | projection
    label: str
    factor: float = (
        2.0  # rate/level: recent >= factor x prior is worsening, recent x factor <= prior improving
    )
    floor: float = (
        1.0  # rate/level: smallest recent value that can be worsening; counter: smallest increase
    )
    push: bool = True  # False: its reasons still read as worsening, but another signal already speaks for them
    dim_name: str = ""  # projection: what a dimension is ("VM " reads "VM 100 used 73%")
    hold_h: float = 48.0  # any/counter: how long one occurrence keeps the verdict worsening
    limit: float | None = None  # projection
    horizon_days: float = 30.0  # projection: worsening when the limit is this close
    critical_days: float | None = (
        None  # projection: failed (not the spec's state) when the limit is this close
    )
    min_slope: float = 0.05  # projection: per-day change below this is flat
    reset_drop: float | None = (
        None  # projection: a day-over-day fall this big (a cleanup) starts a new baseline
    )
    robust: bool = False  # projection: median of pairwise slopes, so a few spikes (a build, a snapshot) are no trend
    fmt: str = "{:.0f}"


@dataclass(frozen=True)
class Spec:
    code: str
    host: str  # site role: pve | workstation
    label: str
    rules: tuple[Rule, ...]
    severity: str = "warn"  # state of a worsening verdict (warn | failed)
    digest_always: bool = False  # otherwise the signal is a note only when not stable


RULE_KEYS = {f.name for f in fields(Rule)}


def spec_from(raw: Mapping[str, Any]) -> Spec:
    """A Spec from its [[checks.trends.specs]] table in checks.toml."""
    rules = tuple(
        Rule(**{k: v for k, v in rule.items() if k in RULE_KEYS}) for rule in raw["rules"]
    )
    return Spec(
        code=raw["code"], host=raw["host"], label=raw["label"], rules=rules, severity=raw.get("severity", "warn"),
        digest_always=bool(raw.get("digest_always", False)),
    )  # fmt: skip


def _r(x: float | None) -> float | None:
    return None if x is None else round(x, 2)


def _days(n: int) -> str:
    return f"{n} day{'s' if n != 1 else ''} of readings"


def _verdict(
    name: str, summary: str, reasons: list[str] | None = None, **numbers: Any
) -> dict[str, Any]:
    return {"verdict": name, "summary": summary, "reasons": reasons or [], **numbers}


def _age(day: str, today: date) -> int:
    return (today - date.fromisoformat(day)).days


def _sum_ages(store: Store, metric: str, host: str, today: date, lo: int, hi: int) -> float:
    """Total of the daily values whose age in days is lo <= age < hi."""
    since = (today - timedelta(days=hi)).isoformat()
    return sum(
        v for _d, day, v in store.daily(metric, host, "", since) if lo <= _age(day, today) < hi
    )


def eval_rate(store: Store, rule: Rule, host: str, now: float) -> dict[str, Any]:
    s = store.series(rule.metric, host)
    if s is None:
        return _verdict("insufficient", f"no {rule.label} data yet")
    today = date.fromtimestamp(now)
    cov = s["coverage_start"] or s["created"]
    covered = max(0.0, (now - cov) / DAY)
    last24 = store.day_value(rule.metric, host, today.isoformat())
    windows = [
        store.day_value(rule.metric, host, (today - timedelta(days=i)).isoformat())
        for i in range(1, 8)
        if now - (i + 1) * DAY >= cov
    ]
    baseline = statistics.median(windows) if windows else None
    recent_d = 7.0 if covered >= 14 else covered / 2
    prior_d = min(30.0, covered) - recent_d
    nums: dict[str, Any] = {
        "last24h": last24, "baseline_daily_median": baseline, "covered_days": round(covered, 1),
        "recent_days": round(recent_d, 1), "prior_days": round(max(prior_d, 0), 1),
    }  # fmt: skip
    if recent_d < 1:
        return _verdict(
            "insufficient",
            f"{last24:g} {rule.label} today",
            [],
            note=f"{covered:.0f} days of data, a trend needs 14",
            **nums,
        )
    n_recent = max(1, round(recent_d))
    rate = _sum_ages(store, rule.metric, host, today, 0, n_recent) / n_recent
    nums["rate_recent_daily"] = _r(rate)
    summary = f"{rule.fmt.format(rate)}/day {rule.label} ({n_recent}d)"
    short = f"{covered:.0f} days of data, a trend needs 14"
    if prior_d < 2:
        return _verdict("insufficient", summary, [], note=short, **nums)
    n_prior = max(1, round(prior_d))
    prior = _sum_ages(store, rule.metric, host, today, n_recent, n_recent + n_prior) / n_prior
    nums["rate_prior_daily"] = _r(prior)
    rising = rate >= rule.floor and rate >= rule.factor * max(prior, rule.floor)
    confident = prior_d >= 7
    nums["rising"] = rising
    if rising and confident:
        return _verdict(
            "worsening",
            summary,
            [f"{rule.label} up to {rule.fmt.format(rate)}/day from {rule.fmt.format(prior)}/day"],
            **nums,
        )
    if not confident:
        lean = (
            "rising"
            if rising
            else "lower"
            if prior >= rule.floor and rate * rule.factor <= prior
            else "level"
        )
        return _verdict("insufficient", summary, [], note=f"{lean} so far; {short}", **nums)
    if prior >= rule.floor and rate * rule.factor <= prior:
        return _verdict("improving", summary, [], **nums)
    return _verdict("stable", summary, [], **nums)  # fmt: skip


def eval_any(store: Store, rule: Rule, host: str, now: float) -> dict[str, Any]:
    today = date.fromtimestamp(now)
    days = max(1, round(rule.hold_h / 24))
    n = _sum_ages(store, rule.metric, host, today, 0, days)
    total = sum(v for _d, _day, v in store.daily(rule.metric, host))
    if n:
        text = f"{n:g} {rule.label} in {rule.hold_h:g}h"
        return _verdict("worsening", text, [text], total=total)
    return _verdict(
        "stable", f"{total:.0f} {rule.label} ever" if total else f"no {rule.label}", total=total
    )


def _by_dim(
    store: Store, metric: str, host: str, since: date
) -> dict[str, list[tuple[str, float]]]:
    out: dict[str, list[tuple[str, float]]] = {}
    for dim, day, value in store.daily(metric, host, None, since.isoformat()):
        out.setdefault(dim, []).append((day, value))
    return out


def eval_counter(store: Store, rule: Rule, host: str, now: float) -> dict[str, Any]:
    today = date.fromtimestamp(now)
    hold_days = max(1, round(rule.hold_h / 24))
    series = _by_dim(store, rule.metric, host, today - timedelta(days=60))
    if not series:
        return _verdict("insufficient", f"no {rule.label} data yet")
    reasons, values, short = [], {}, []
    cutoff = (today - timedelta(days=hold_days)).isoformat()
    for dim, pts in series.items():
        values[dim] = pts[-1][1]
        before = [v for d, v in pts if d <= cutoff]
        if not before:
            short.append(dim)
            continue
        rise, prev = 0.0, before[-1]
        for (
            d,
            v,
        ) in pts:  # increases after the cutoff; a drop is a counter reset and the new baseline
            if d > cutoff:
                rise += max(0.0, v - prev)
                prev = v
        if rise >= rule.floor:
            reasons.append(
                f"{rule.label} on {dim} up by {rule.fmt.format(rise)} in {hold_days}d (now {rule.fmt.format(values[dim])})"
            )
    worst = max(values.values())
    summary = f"{rule.label} {rule.fmt.format(worst)}" + (
        f" (max of {len(values)})" if len(values) > 1 else ""
    )
    if reasons:
        return _verdict("worsening", summary, reasons, values=values)
    if len(short) == len(series):
        return _verdict(
            "insufficient", summary, values=values, note=f"under {_days(hold_days + 1)}"
        )
    return _verdict("stable", summary, values=values)


def eval_level(store: Store, rule: Rule, host: str, now: float) -> dict[str, Any]:
    today = date.fromtimestamp(now)
    series = _by_dim(store, rule.metric, host, today - timedelta(days=30))
    if not series:
        return _verdict("insufficient", f"no {rule.label} data yet")
    split = (today - timedelta(days=6)).isoformat()
    best: dict[str, Any] | None = None
    for dim, pts in series.items():
        recent = [v for d, v in pts if d >= split]
        prior = [v for d, v in pts if d < split]
        if not recent:
            continue
        r = statistics.fmean(recent)
        name = f"{rule.label}{' ' + dim if dim else ''}"
        summary = f"{name} {rule.fmt.format(r)} (7d avg)"
        if len(prior) < 3:
            v = _verdict("insufficient", summary, recent=_r(r), note=_days(len(pts)))
        else:
            p = statistics.fmean(prior)
            rising = r >= rule.floor and r >= rule.factor * max(p, rule.floor)
            if rising and len(prior) >= 7:
                v = _verdict(
                    "worsening",
                    summary,
                    [f"{name} up to {rule.fmt.format(r)} from {rule.fmt.format(p)}"],
                    recent=_r(r),
                    prior=_r(p),
                )
            elif rising:
                v = _verdict(
                    "insufficient", summary, recent=_r(r), prior=_r(p), note="rising so far"
                )
            elif p >= rule.floor and r * rule.factor <= p and len(prior) >= 7:
                v = _verdict("improving", summary, recent=_r(r), prior=_r(p))
            else:
                v = _verdict("stable", summary, recent=_r(r), prior=_r(p))
        if best is None or RANK[v["verdict"]] < RANK[best["verdict"]]:
            best = v
    return best or _verdict("insufficient", f"no recent {rule.label} data")


def slope(points: list[tuple[float, float]]) -> float:
    """Least-squares slope (value per x unit)."""
    n = len(points)
    mx = sum(x for x, _ in points) / n
    my = sum(y for _, y in points) / n
    den = sum((x - mx) ** 2 for x, _ in points)
    return 0.0 if den == 0 else sum((x - mx) * (y - my) for x, y in points) / den


def robust_slope(points: list[tuple[float, float]]) -> float:
    """Theil-Sen slope: the median slope over all point pairs, so a handful of outliers cannot tilt it."""
    slopes = [
        (y2 - y1) / (x2 - x1)
        for i, (x1, y1) in enumerate(points)
        for x2, y2 in points[i + 1 :]
        if x2 != x1
    ]
    return statistics.median(slopes) if slopes else 0.0


def eval_projection(store: Store, rule: Rule, host: str, now: float) -> dict[str, Any]:
    today = date.fromtimestamp(now)
    series = _by_dim(store, rule.metric, host, today - timedelta(days=14))
    if not series:
        return _verdict("insufficient", f"no {rule.label} data yet")
    best: dict[str, Any] | None = None
    for dim, pts in series.items():
        cur = pts[-1][1]
        name = f"{rule.dim_name}{dim} {rule.label}" if dim else rule.label
        summary = f"{name} {rule.fmt.format(cur)}"
        if rule.reset_drop is not None:
            cut = max(
                (i for i in range(1, len(pts)) if pts[i - 1][1] - pts[i][1] >= rule.reset_drop),
                default=0,
            )
            pts = pts[cut:]
        xs = [(float((date.fromisoformat(d) - today).days), v) for d, v in pts]
        if len(xs) < 5 or xs[-1][0] - xs[0][0] < 4:
            v = _verdict("insufficient", summary, current=cur, note=_days(len(xs)))
        else:
            k = robust_slope(xs) if rule.robust else slope(xs)
            nums: dict[str, Any] = {"current": cur, "slope_per_day": _r(k)}
            if rule.limit is not None and k >= rule.min_slope:
                days = (rule.limit - cur) / k
                nums["days_to_limit"] = round(days, 1)
                summary += f", +{k:.2f}/day"
                if days <= rule.horizon_days:
                    v = _verdict(
                        "worsening",
                        summary,
                        [
                            f"{name} reaches {rule.fmt.format(rule.limit)} in ~{max(days, 0):.0f} days"
                        ],
                        **nums,
                    )
                else:
                    v = _verdict("stable", summary, **nums)
            elif k <= -rule.min_slope:
                v = _verdict("improving", summary + f", {k:.2f}/day", **nums)
            else:
                v = _verdict("stable", summary, **nums)
        # the worst verdict leads; among equal verdicts the fullest dimension (the disk nearest its limit)
        if best is None or (RANK[v["verdict"]], -cur) < (RANK[best["verdict"]], -best["current"]):
            best = v
    return best or _verdict("insufficient", f"no {rule.label} data")


EVALUATORS: dict[str, Callable[[Store, Rule, str, float], dict[str, Any]]] = {
    "rate": eval_rate, "any": eval_any, "counter": eval_counter, "level": eval_level, "projection": eval_projection,
}  # fmt: skip


def evaluate(store: Store, spec: Spec, now: float) -> dict[str, Any]:
    results = {r.metric: EVALUATORS[r.kind](store, r, spec.host, now) for r in spec.rules}
    verdicts = [v["verdict"] for v in results.values()]
    if "worsening" in verdicts:
        verdict = "worsening"
    elif (
        verdicts[0] == "insufficient"
    ):  # the first rule is the spec's headline; the others only add reasons
        verdict = "insufficient"
    elif "improving" in verdicts:
        verdict = "improving"
    else:
        verdict = "stable"
    reasons = [x for v in results.values() for x in v["reasons"]]
    pushing = any(r.push and results[r.metric]["verdict"] == "worsening" for r in spec.rules)
    notes = [
        v["note"] for v in results.values() if v.get("note") and v["verdict"] == "insufficient"
    ]
    return {
        "verdict": verdict,
        "reasons": reasons,
        "notes": notes,
        "rules": results,
        "pushing": pushing,
    }


VERDICT_TEXT = {
    "worsening": "worsening",
    "improving": "improving",
    "stable": "stable",
    "insufficient": "not enough history yet",
}


def line(spec: Spec, ev: dict[str, Any], names: Mapping[str, str]) -> str:
    """'PVE host thin pool: pve/data data 65.3%, +0.99/day, worsening: pve/data data reaches 92.0% in ~27 days'."""
    first = next(iter(ev["rules"].values()))
    status = VERDICT_TEXT[ev["verdict"]]
    if ev["reasons"]:
        status += ": " + "; ".join(ev["reasons"][:3])
    elif ev["verdict"] == "insufficient" and ev["notes"]:
        status += f" ({ev['notes'][0]})"
    return f"{names.get(spec.host, spec.host)} {spec.label}: {first['summary']}, {status}"


def urgent(spec: Spec, ev: dict[str, Any]) -> bool:
    """A worsening projection whose limit is within its rule's critical_days."""
    for r in spec.rules:
        res = ev["rules"].get(r.metric) or {}
        days = res.get("days_to_limit")
        if (
            r.critical_days is not None
            and res.get("verdict") == "worsening"
            and isinstance(days, int | float)
            and days <= r.critical_days
        ):
            return True
    return False


def state_of(spec: Spec, ev: dict[str, Any]) -> str:
    """ok | warn | failed before the tier step: worsening speaks at the spec's state (failed when the limit is days away)."""
    if ev["verdict"] == "worsening" and ev.get("pushing", True):
        return "failed" if urgent(spec, ev) else spec.severity
    return "ok"
