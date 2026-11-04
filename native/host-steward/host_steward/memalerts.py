"""Memory losses for the owner: what memctl, Tether's memory guard, the kernel and Tether recovery recorded, classed
into incidents. Port of the classing part of ns/memalerts.py (the push texts, dedup keys and CLI went with the
outbox: the memory check turns incidents into one Status row).

Sources, all read-only: the memory event record (memevents.py), the kernel journal (`oom-kill:` lines, so kills are
seen while memctl is down), the user manager's unit results (`Failed with result 'oom-kill'`) for the containers
(agent panes, Aico web, the tmux servers), Tether's crash recoveries (recoveries.json) and Tether's own startup and
lifecycle lines (a pane a non-default Tether instance owned is a test pane, never an incident).

Classes: pane-stopped (a whole pane, Aico web or a tmux server stopped after an OOM kill), agent-lost, kill-loop (N kills
in one pane within a window), agent-hog, outside-hog, held (Tether stopped resuming a crashing session), tool-kill
(a tool died; the pane and agent survive: told to the agent, not the owner), recovered, recovering. PUSH_CLASSES
say which a person has to look at.
"""

from __future__ import annotations

import contextlib
import json
import re
from typing import Any

from host_steward import memevents

UNIT_FAILED = memevents.UNIT_FAILED
# tmux names a pane's scope tmux-spawn-<uuid>.scope; any other tmux-spawn-* name is a hand-made test unit
PANE = re.compile(r"tmux-spawn-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.scope")
CONTAINER = re.compile(PANE.pattern + r"|aico-web\.service|[\w.@-]*tmux-server[\w.@-]*\.service")
PROOF_UNIT = re.compile(
    r"(tmux-spawn-)?zz"
)  # throwaway proof units (zzv-*, tmux-spawn-zzv-*) never alert
AGENT_COMMS = frozenset({"claude", "codex"})
WIDGET = re.compile(r"[0-9a-f]{8}")
UNIT = re.compile(r"[\w@.:-]{1,160}")
PUSH_CLASSES = frozenset(
    {"pane-stopped", "agent-lost", "kill-loop", "agent-hog", "outside-hog", "held"}
)
G = 2**30


def gib(n: Any) -> str:
    n = n or 0
    return f"{n / G:.1f} GiB" if n >= G else f"{n / 2**20:.0f} MiB"


def journal_units(lines: list[str]) -> list[dict[str, Any]]:
    """`journalctl -o json` lines of the user manager -> container failures {ts, unit, result}, result oom-kill or
    signal. incidents() counts a stop on its own for oom-kill, and for signal only for a container other than a pane
    next to a kernel kill (its main process killed); a pane's signal result only confirms memctl's pane-stopped record."""
    out = []
    for line in lines:
        with contextlib.suppress(ValueError, KeyError, TypeError):
            d = json.loads(line)
            unit, result = str(d.get("USER_UNIT") or d.get("UNIT") or ""), d.get("UNIT_RESULT")
            if CONTAINER.fullmatch(unit) and result in memevents.FAILED_RESULTS:
                out.append(
                    {"ts": int(d["__REALTIME_TIMESTAMP"]) / 1e6, "unit": unit, "result": result}
                )
    return out


TETHER_START = re.compile(r"\[tether\] \S+ instance=([a-z0-9][a-z0-9-]{0,31}) listening on ")
TETHER_EVENT = "[tether:event] "
TEST_SERVER = re.compile(
    r"tether-[a-z0-9][a-z0-9-]{0,31}-tmux-server-[0-9a-f]{8,64}\.service"
)  # non-default instance
TETHER_LINES = r'instance=[a-z0-9-]+ listening on |"event":"lifecycle_(scope|tmux_server)_owned"'  # journalctl -g


def test_panes(lines: list[str]) -> set[str]:
    """`journalctl -o json` lines of Tether daemons (their startup line and lifecycle events) -> the pane scopes a
    non-default Tether instance owned. A daemon is one instance for its life: the startup line names it, and only a
    non-default instance runs its tmux servers as tether-<instance>-tmux-server-<id>.service. Its panes get ordinary
    tmux-spawn-<uuid>.scope names, so the name alone cannot tell them from the owner's windows."""
    rows = []
    for line in lines:
        with contextlib.suppress(ValueError, KeyError, TypeError, AttributeError):
            d = json.loads(line)
            rows.append((int(d["__REALTIME_TIMESTAMP"]) / 1e6, str(d["_PID"]), str(d["MESSAGE"])))
    started: dict[
        str, list[tuple[float, bool]]
    ] = {}  # daemon pid -> (ts, is a test instance) of each start
    server_test: dict[
        str, list[float]
    ] = {}  # daemon pid -> when it owned a non-default instance's tmux server
    owned: list[tuple[float, str, str]] = []
    for ts, pid, msg in sorted(rows):
        if m := TETHER_START.match(msg):
            started.setdefault(pid, []).append((ts, m[1] != "default"))
        elif msg.startswith(TETHER_EVENT):
            with contextlib.suppress(ValueError, TypeError, AttributeError):
                ev = json.loads(msg[len(TETHER_EVENT) :])
                unit = str(ev.get("scope_unit") or "")
                if ev.get("event") == "lifecycle_tmux_server_owned" and TEST_SERVER.fullmatch(unit):
                    server_test.setdefault(pid, []).append(ts)
                elif ev.get("event") == "lifecycle_scope_owned" and UNIT.fullmatch(unit):
                    owned.append((ts, pid, unit))
    out = set()
    for ts, pid, unit in owned:
        starts = started.get(pid, [])
        last = [
            t for t in starts if t[0] <= ts
        ]  # pids are reused: the start before this event counts
        if last:
            test = last[-1][1]
        else:  # started before the window: only its own server lines count, those before this pid's next start
            first = starts[0][0] if starts else float("inf")
            test = any(t < first for t in server_test.get(pid, []))
        if test:
            out.add(unit)
    return out


def journal_read(rc: int, out: str) -> bool:
    """Whether a `journalctl -o json` run (no -g) was read: exit 0, and some line parses when there is output. A
    warning on stderr (a corrupted file it skipped) does not make the rest unread."""
    if rc != 0:
        return False
    lines = [ln for ln in out.splitlines() if ln.strip()]
    if not lines:
        return True
    for line in lines:
        with contextlib.suppress(ValueError):
            if isinstance(json.loads(line), dict):
                return True
    return False


def _ms(v: Any) -> float | None:
    return (
        float(v) / 1000
        if isinstance(v, int | float) and not isinstance(v, bool) and v > 0
        else None
    )


def tether_recoveries(doc: Any) -> list[dict[str, Any]]:
    """Tether crash records, from recoveries.json (v1 `records`, camelCase) or `tether recovery status --json` (v1
    `sessions`, snake_case), normalised; anything else is [] (no recovery incidents)."""
    if not isinstance(doc, dict) or doc.get("v") != 1:
        return []
    rows = doc.get("records") if isinstance(doc.get("records"), list) else doc.get("sessions")
    out = []
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, dict):
            continue

        def g(snake: str, camel: str, r: dict = r) -> Any:
            return r.get(camel, r.get(snake))

        rid, state, died = str(r.get("id") or ""), g("state", "state"), _ms(g("died_at", "diedAt"))
        if (
            not WIDGET.fullmatch(rid)
            or state not in ("waiting", "recovering", "recovered", "held")
            or died is None
        ):
            continue
        v = r.get("victim") if isinstance(r.get("victim"), dict) else {}
        attempt = g("attempt", "attempt")
        rss = g("rss_bytes", "rssBytes", v)
        out.append(
            {
                "id": rid,
                "name": str(r.get("name") or "")[:80] or None,
                "state": state,
                "kind": str(r.get("kind") or "")[:40],
                "cause": str(r.get("cause") or "")[:40],
                "signal": r.get("signal") if isinstance(r.get("signal"), int) else None,
                "agent_was_hog": bool(g("agent_was_hog", "agentWasHog")),
                "victim": {
                    "pid": v.get("pid") if isinstance(v.get("pid"), int) else None,
                    "comm": str(v.get("comm") or "")[:40] or None,
                    "bytes": rss if isinstance(rss, int) else None,
                }
                if v
                else None,
                "died_at": died,
                "recovered_at": _ms(g("recovered_at", "recoveredAt")),
                "attempt": attempt
                if isinstance(attempt, int) and not isinstance(attempt, bool)
                else 0,
                "reason": str(r.get("reason") or "")[:200] or None,
                "scope": str(g("scope_unit", "scopeUnit") or "") or None,
            }
        )
    return out


def _kills(records: list[dict], kernel: list[dict], match_s: float) -> list[dict[str, Any]]:
    """memctl's kill records plus kernel journal kills it did not record (memctl down or its record lacks the line)."""
    out: list[dict[str, Any]] = []
    for r in records:
        if r.get("kind") == "kill":
            count = r.get("count")
            n = count if r.get("pid") is None and isinstance(count, int) else 1
            if r.get("late") is True and r.get("pid") is not None:
                # the journal line memctl read after it wrote a counter-only record for this kill: it replaces it
                same = next(
                    (
                        o
                        for o in out
                        if o["pid"] is None
                        and o["scope"] == r.get("scope")
                        and abs(float(r.get("ts") or 0) - o["ts"]) < match_s
                    ),
                    None,
                )
                if same is not None:
                    out.remove(same)
            out += [
                {
                    "ts": float(r.get("ts") or 0),
                    "pid": r.get("pid"),
                    "comm": r.get("comm"),
                    "bytes": r.get("bytes"),
                    "scope": r.get("scope"),
                    "killer": r.get("killer"),
                    "class": r.get("class"),
                    "widget": r.get("tether_session_id"),
                }
                for _ in range(max(1, min(n, 20)))  # counter-only: count kills
            ]
    for k in kernel:
        if any(
            o["pid"] == k["pid"] and abs(o["ts"] - k["ts"]) < match_s
            for o in out
            if o["pid"] is not None
        ):
            continue
        # a counter-only memctl kill (no pid) for the same scope is this kill: the journal line replaces it
        same = next(
            (
                o
                for o in out
                if o["pid"] is None
                and o["scope"] == k["scope"]
                and abs(o["ts"] - k["ts"]) < match_s
            ),
            None,
        )
        if same is not None:
            out.remove(same)
        out.append(
            {
                "ts": k["ts"],
                "pid": k["pid"],
                "comm": k["comm"],
                "bytes": k["bytes"],
                "scope": k["scope"],
                "killer": k["killer"],
                "class": "agent" if k["comm"] in AGENT_COMMS else None,
                "widget": None,
            }
        )
    return sorted((o for o in out if not test_unit(str(o["scope"] or ""))), key=lambda o: o["ts"])


def test_unit(name: str) -> bool:
    """A proof or hand-made test unit (zzv-*, tmux-spawn-<not a uuid>.scope): never an incident."""
    return bool(PROOF_UNIT.match(name)) or (
        name.startswith("tmux-spawn-") and not PANE.fullmatch(name)
    )


def _cause(k: dict | None) -> dict[str, Any]:
    return {f: k.get(f) for f in ("ts", "pid", "comm", "bytes", "killer")} if k else {}


def incidents(
    records: list[dict],
    kernel: list[dict],
    stops: list[dict],
    recoveries: list[dict],
    now: float,
    test_scopes: set[str] | frozenset[str],
    *,
    window_s: float,
    match_s: float,
    loop_n: int,
    loop_s: float,
    tether_grace_s: float,
) -> list[dict[str, Any]]:
    """Incidents of the last window_s, newest first. Each: class, ts, scope, widget (Tether session id or None),
    name, push (a person has to look) and why_not (when push is False). Nothing in a test unit (test_unit, or a pane
    in test_scopes) is an incident."""
    since = now - window_s

    def real(scope: Any) -> bool:
        return not (scope and (test_unit(str(scope)) or str(scope) in test_scopes))

    records = [
        r
        for r in records
        if isinstance(r, dict) and float(r.get("ts") or 0) > since and real(r.get("scope"))
    ]
    kernel = [k for k in kernel if real(k.get("scope"))]
    stops = [s for s in stops if real(s.get("unit"))]
    recoveries = [t for t in recoveries if real(t.get("scope"))]
    widget_of: dict[
        str, str
    ] = {}  # scope -> Tether session id, from memctl's records and Tether's crash records
    for r in records:
        if r.get("scope") and WIDGET.fullmatch(str(r.get("tether_session_id") or "")):
            widget_of[str(r["scope"])] = str(r["tether_session_id"])
    for t in recoveries:
        if t["scope"]:
            widget_of.setdefault(t["scope"], t["id"])
    names = {t["id"]: t["name"] for t in recoveries if t["name"]}
    kills = [
        k
        for k in _kills(records, [k for k in kernel if k["ts"] > since], match_s)
        if k["ts"] > since
    ]
    out: list[dict[str, Any]] = []

    def add(
        cls: str, ts: float, scope: str | None, widget: str | None = None, **fields: Any
    ) -> dict[str, Any]:
        # the record file is the owner's (agents can write it): only unit-shaped scopes and 8-hex session ids pass
        scope = scope if scope and UNIT.fullmatch(str(scope)) else None
        widget = widget if widget and WIDGET.fullmatch(str(widget)) else None
        widget = widget or (widget_of.get(scope) if scope else None)
        inc = {
            "class": cls,
            "ts": round(ts, 3),
            "scope": scope,
            "widget": widget,
            "name": names.get(widget) if widget else None,
            "push": cls in PUSH_CLASSES,
            "why_not": None,
            **fields,
        }
        out.append(inc)
        return inc

    # whole containers stopped: the unit result, or memctl's pane-stopped record when the journal has none. A 'signal'
    # result is an OOM loss only with a kernel kill in that unit just before it (else someone stopped it)
    def killed_near(unit: str, ts: float) -> bool:
        return any(k["scope"] == unit and ts - match_s <= k["ts"] <= ts + 5 for k in kills)

    pane_stops: list[dict[str, Any]] = [
        {"ts": s["ts"], "unit": s["unit"], "agent": None}
        for s in stops
        if s["ts"] > since
        and (
            s.get("result", "oom-kill") == "oom-kill"
            or (not PANE.fullmatch(s["unit"]) and killed_near(s["unit"], s["ts"]))
        )
    ]

    def lost(unit: str, ts: float) -> bool:
        """The pane's unit failed (oom-kill or signal) in the unit journal, or a kernel kill took its root shell or
        agent then: under OOMPolicy=continue a pane ends with Result=success whatever ended it."""
        return any(s["unit"] == unit and ts - 5 <= s["ts"] <= ts + match_s for s in stops) or any(
            k["scope"] == unit
            and ts - match_s <= k["ts"] <= ts + 5
            and k["class"] in ("container", "agent")
            for k in kills
        )

    for r in records:
        if r.get("kind") != "pane-stopped" or not CONTAINER.fullmatch(str(r.get("scope") or "")):
            continue
        # a pane that ended cleanly after a tool kill is no loss: the record counts only with the loss in the kills
        # or the unit journal
        if not lost(str(r["scope"]), float(r["ts"])):
            continue
        agent = r.get("agent") if r.get("agent") in AGENT_COMMS else None
        same = [
            p
            for p in pane_stops
            if p["unit"] == r["scope"] and abs(p["ts"] - float(r["ts"])) < match_s
        ]
        for p in same:
            p["agent"] = p["agent"] or agent
        if not same:
            pane_stops.append({"ts": float(r["ts"]), "unit": str(r["scope"]), "agent": agent})
    used: set[int] = set()
    losses = []
    for s in sorted(pane_stops, key=lambda s: s["ts"]):
        near = [
            i
            for i, k in enumerate(kills)
            if k["scope"] == s["unit"] and s["ts"] - match_s <= k["ts"] <= s["ts"] + 5
        ]
        used.update(near)
        top = max((kills[i] for i in near), key=lambda k: k["bytes"] or 0, default=None)
        losses.append(
            add(
                "pane-stopped",
                s["ts"],
                s["unit"],
                top["widget"] if top else None,
                cause=_cause(top),
                agent=s["agent"],
            )
        )
    for i, k in enumerate(kills):
        if i in used:
            continue
        if k["class"] == "agent":
            losses.append(add("agent-lost", k["ts"], k["scope"], k["widget"], cause=_cause(k)))
        else:
            add("tool-kill", k["ts"], k["scope"], k["widget"], cause=_cause(k))
    # repeated kills in one pane (loop_n within loop_s): one incident per pane per loop_s
    by_scope: dict[str, list[dict]] = {}
    for k in kills:
        if PANE.fullmatch(str(k["scope"] or "")):
            by_scope.setdefault(k["scope"], []).append(k)
    loop_n = max(1, int(loop_n))  # a config of 0 or less would index past the list
    for scope, ks in by_scope.items():
        last = float("-inf")
        for j in range(loop_n - 1, len(ks)):
            if ks[j]["ts"] - ks[j - loop_n + 1]["ts"] <= loop_s and ks[j]["ts"] - last > loop_s:
                last = ks[j]["ts"]
                n = sum(1 for k in ks if last - loop_s <= k["ts"] <= last)
                add("kill-loop", last, scope, ks[j]["widget"], count=n, cause=_cause(ks[j]))
    for r in records:
        if r.get("kind") in ("agent-hog", "outside-hog") and r.get("scope"):
            add(
                str(r["kind"]),
                float(r["ts"]),
                str(r["scope"]),
                r.get("tether_session_id") or None,
                cause={
                    "pid": r.get("pid"),
                    "comm": r.get("comm"),
                    "bytes": r.get("bytes"),
                    "killer": None,
                },
            )
    # Tether's crash recoveries: a loss it recovered or holds is told once, through the recovery incident
    for t in recoveries:
        if t["died_at"] <= since:
            continue
        match = [
            x
            for x in losses
            if (x["widget"] == t["id"] or (t["scope"] and x["scope"] == t["scope"]))
            and abs(x["ts"] - t["died_at"]) < match_s
        ]
        cause = next((x["cause"] for x in match if x.get("cause")), None) or (
            {
                "pid": t["victim"]["pid"],
                "comm": t["victim"]["comm"],
                "bytes": t["victim"]["bytes"],
                "killer": None,
            }
            if t["victim"]
            else {}
        )
        for x in match:
            x["push"], x["why_not"], x["widget"] = (
                False,
                f"Tether: {t['state']}",
                x["widget"] or t["id"],
            )
            x["tether_state"] = t["state"]
        if t["state"] in ("recovered", "held"):
            inc = add(t["state"], t["died_at"], t["scope"], t["id"], cause=cause)
            if t["state"] == "recovered":
                inc["why_not"] = "Tether resumed it on its own"
        else:
            add("recovering", t["died_at"], t["scope"], t["id"], cause=cause)
    for x in losses:
        if x["push"] and now - x["ts"] < tether_grace_s:
            x["push"], x["why_not"] = False, "waiting for Tether's crash record"
    return sorted(out, key=lambda x: -x["ts"])


def unit_name(unit: str) -> str:
    """A short name for a unit: app-com.google.Chrome-4039647.scope -> Chrome, docker-shadow.service -> docker-shadow."""
    name = re.sub(r"\.(scope|service)$", "", unit)
    name = re.sub(r"-\d+$", "", re.sub(r"^app-", "", name))
    return name.rsplit(".", 1)[-1] or unit


def window(inc: dict) -> str:
    """Tether's name for the session, else what the unit is."""
    title = inc.get("name")
    if title:
        return " ".join(str(title).split())[:40]
    unit, w = str(inc.get("scope") or ""), str(inc.get("widget") or "")
    if unit == "aico-web.service":
        return "Aico web"
    if "tmux-server" in unit:
        return "A tmux server"
    if w:
        return f"Session {w}"
    return "An agent session" if PANE.fullmatch(unit) or not unit else unit


def what(cause: dict | None) -> str:
    if not cause or not cause.get("comm"):
        return "a process"
    return f"{cause['comm']} ({gib(cause['bytes'])})" if cause.get("bytes") else str(cause["comm"])


WORDS = {
    "pane-stopped": "closed by an OOM kill",
    "agent-lost": "agent killed",
    "kill-loop": "jobs killed again and again",
    "agent-hog": "agent was the biggest memory user",
    "outside-hog": "memory critical, nothing to stop",
    "held": "held after repeated crashes",
    "recovered": "recovered after a crash",
    "recovering": "recovering after a crash",
}


def line(inc: dict) -> str:
    """One incident in plain words, for the row."""
    who = window(inc)
    if inc["class"] == "tool-kill":
        return f"{what(inc.get('cause'))} killed in {who}"
    if inc["class"] == "outside-hog":
        return f"{WORDS['outside-hog']}: {unit_name(str(inc.get('scope') or ''))} held {gib((inc.get('cause') or {}).get('bytes'))}"
    return f"{who}: {WORDS.get(inc['class'], inc['class'])}"
