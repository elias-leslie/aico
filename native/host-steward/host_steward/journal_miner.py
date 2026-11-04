"""Journal signature clustering: a compact Drain-style template miner with a persistent cursor.

Port of ns/checks/journal.py's miner. Clusters keep a stable id (assigned at creation) while their template
generalizes, so day-over-day counts and "new since yesterday" stay meaningful. The settings (similarity, caps,
retention, the known-signature table) are in checks.toml [checks.journal]; the masks below define what a "same
message" is and stay in code.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

WILDCARD = "<*>"

_MASKS = [
    (
        re.compile(
            r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE
        ),
        "<UUID>",
    ),
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b"), "<IP>"),
    (re.compile(r"\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b", re.IGNORECASE), "<HEX>"),
    (re.compile(r"/tmp/[^\s'\"]+"), "<TMP>"),
    (re.compile(r"\d+"), "<N>"),
]
HASH = re.compile(
    r"[0-9a-f]{8,}"
)  # container ids and name suffixes (st-ci-postgres-67cf51bc): one ident for all


def tokenize(message: str) -> list[str]:
    for rx, repl in _MASKS:
        message = rx.sub(repl, message)
    return message.split()


def ident_of(raw: str) -> str:
    return HASH.sub("<H>", raw)


@dataclass
class Cluster:
    id: str
    ident: str
    template: list[str]
    count: int = 0
    first_seen: str = ""
    last_seen: str = ""
    priority: int = 7
    example: str = ""
    daily: dict[str, int] = field(default_factory=dict)

    def text(self) -> str:
        return " ".join(self.template)


def _similarity(template: list[str], tokens: list[str]) -> float:
    same = sum(1 for a, b in zip(template, tokens, strict=True) if a in (b, WILDCARD))
    return same / max(len(tokens), 1)


class Miner:
    def __init__(
        self, clusters: Iterable[Cluster] = (), similarity: float = 0.5, max_per_group: int = 200
    ):
        self.similarity = similarity
        self.max_per_group = max_per_group
        self.groups: dict[tuple[str, int, str], list[Cluster]] = {}
        for c in clusters:
            self._group(c.ident, c.template).append(c)

    @staticmethod
    def _key(ident: str, tokens: list[str]) -> tuple[str, int, str]:
        first = tokens[0] if tokens and not tokens[0].startswith("<") else WILDCARD
        return (ident, len(tokens), first)

    def _group(self, ident: str, tokens: list[str]) -> list[Cluster]:
        return self.groups.setdefault(self._key(ident, tokens), [])

    def add(self, ident: str, message: str, ts: datetime, priority: int = 7) -> Cluster:
        tokens = tokenize(message) or ["<empty>"]
        group = self._group(ident, tokens)
        best, best_sim = None, 0.0
        for c in group:
            sim = _similarity(c.template, tokens)
            if sim > best_sim:
                best, best_sim = c, sim
        if best is None or best_sim < self.similarity:
            if len(group) >= self.max_per_group:
                best = min(group, key=lambda c: c.count)
            else:
                cid = hashlib.sha1(f"{ident}\x00{' '.join(tokens)}".encode()).hexdigest()[:12]
                best = Cluster(cid, ident, tokens, first_seen=ts.isoformat(), example=message[:300])
                group.append(best)
        best.template = [
            a if a == b else WILDCARD for a, b in zip(best.template, tokens, strict=True)
        ]
        best.count += 1
        best.priority = min(best.priority, priority)
        best.last_seen = max(best.last_seen, ts.isoformat())
        day = ts.date().isoformat()
        best.daily[day] = best.daily.get(day, 0) + 1
        return best

    def clusters(self) -> list[Cluster]:
        return [c for g in self.groups.values() for c in g]


def compile_known(
    known: Sequence[Mapping[str, str]],
) -> list[tuple[Mapping[str, str], re.Pattern[str]]]:
    """Patterns match at the START of the message (re.match): text found mid-line is attacker-controllable (a sudo
    COMMAND=, an ssh user name, a file name) and must never turn an alert into noise."""
    return [(k, re.compile(k["pattern"])) for k in known]


def classify(
    cluster: Cluster, known: list[tuple[Mapping[str, str], re.Pattern[str]]]
) -> Mapping[str, str] | None:
    for entry, rx in known:
        if rx.match(cluster.example) or rx.match(cluster.text()):
            return entry
    return None


def _ident(entry: Mapping[str, Any]) -> str:
    return ident_of(
        str(
            entry.get("SYSLOG_IDENTIFIER")
            or entry.get("_SYSTEMD_UNIT")
            or entry.get("_COMM")
            or "?"
        )
    )


def _message(entry: Mapping[str, Any]) -> str | None:
    msg = entry.get("MESSAGE")
    if isinstance(msg, list):  # journald encodes non-UTF8 messages as byte arrays
        try:
            msg = bytes(msg).decode("utf-8", "replace")
        except (TypeError, ValueError):
            return None
    return msg if isinstance(msg, str) else None


def from_container(entry: Mapping[str, Any]) -> bool:
    """A container's stdout/stderr (Docker's and Podman's journald log drivers set CONTAINER_ID): every stderr line
    lands at priority 3, so it is the app's output, not a host warning. Each container's project watches its own."""
    return bool(entry.get("CONTAINER_ID") or entry.get("CONTAINER_ID_FULL"))


def ingest(miner: Miner, lines: Iterable[str]) -> tuple[int, str | None]:
    n, cursor = 0, None
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        cursor = entry.get("__CURSOR", cursor)
        if from_container(entry):
            continue
        msg = _message(entry)
        if not msg:
            continue
        ts = datetime.fromtimestamp(int(entry.get("__REALTIME_TIMESTAMP", 0)) / 1e6, UTC)
        miner.add(_ident(entry), msg, ts, int(entry.get("PRIORITY", 7)))
        n += 1
    return n, cursor


def report(
    miner: Miner,
    now: datetime,
    top_n: int,
    known: list[tuple[Mapping[str, str], re.Pattern[str]]],
    baseline_at: str = "",
) -> dict[str, Any]:
    """baseline_at: first-run time; clusters first seen before it are history, never 'new'."""
    today = now.date()
    last24_days = {today.isoformat(), (today - timedelta(days=1)).isoformat()}
    new_cut = max((now - timedelta(hours=24)).isoformat(), baseline_at)
    rows = []
    for c in miner.clusters():
        hit = classify(c, known)
        rows.append(
            {
                "id": c.id,
                "ident": c.ident,
                "template": c.text(),
                "example": c.example,
                "priority": c.priority,
                "count_total": c.count,
                "count_recent": sum(v for d, v in c.daily.items() if d in last24_days),
                "first_seen": c.first_seen,
                "last_seen": c.last_seen,
                "new_since_yesterday": c.first_seen > new_cut,
                "label": hit["label"] if hit else None,
                "known": hit["name"] if hit else None,
            }
        )
    rows.sort(key=lambda r: (r["count_recent"], r["count_total"]), reverse=True)
    return {
        "generated_at": now.isoformat(),
        "count_recent_window": "UTC today + yesterday",
        "clusters_total": len(rows),
        "signatures": rows[:top_n],
        "new_unlabeled": [r for r in rows if r["new_since_yesterday"] and not r["label"]][:top_n],
    }


def load_clusters(data: Mapping[str, Any]) -> tuple[str | None, list[Cluster], str]:
    """(cursor, clusters, baseline_at) from a saved state dict; a bad entry is dropped, not fatal."""
    clusters = []
    for raw in data.get("clusters", []):
        try:
            c = Cluster(**raw)
        except TypeError:
            continue
        c.ident = ident_of(c.ident)  # state from before the masking joins the masked ident
        clusters.append(c)
    return data.get("cursor"), clusters, str(data.get("baseline_at") or "")


def state_dict(
    cursor: str | None,
    clusters: list[Cluster],
    now: datetime,
    baseline_at: str,
    retain_days: int,
    per_ident: int,
) -> dict[str, Any]:
    """Clusters seen in retain_days, at most per_ident per identifier (the most recently seen)."""
    cut = (now - timedelta(days=retain_days)).isoformat()
    day_cut = (now - timedelta(days=retain_days)).date().isoformat()
    kept, per = [], dict[str, int]()
    for c in sorted(clusters, key=lambda c: c.last_seen, reverse=True):
        if c.last_seen >= cut and per.get(c.ident, 0) < per_ident:
            per[c.ident] = per.get(c.ident, 0) + 1
            c.daily = {d: v for d, v in c.daily.items() if d >= day_cut}
            kept.append(asdict(c))
    return {"cursor": cursor, "baseline_at": baseline_at, "clusters": kept}
