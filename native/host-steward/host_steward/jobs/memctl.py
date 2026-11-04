"""host-steward memctl [--once] [--preview]: the memory controller (a user service, every tick_s seconds).

Publishes the host's memory and disk state as the admission file (contract v1: Tether's agent admission and memory
guard, SummitFlow's heavy_work and host-monitor read it) and its heartbeat, and records what the kernel killed as
memory events (kernel kills, pane-stopped, outside-hog). It signals, freezes and kills nothing: the panes are read
from cgroups and /proc, and agent tool jobs are Tether's to stop. Port of ns/memctl.py; the numbers are [memctl] in
data/checks.toml.

Its only effect on the host is writing those files, so [acting] memctl switches them: off (the default until
cutover) it computes everything and writes the same files under host-steward's own names, never Nightshift's live
admission.json, heartbeat or event record; on, it writes the live ones (the paths Tether and SummitFlow read).
It posts its Status row (service-memctl) when the state changes and at most every row_every_s.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sqlite3
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aico_status
from host_steward import core, memevents, memstate, panes
from host_steward.memstate import G, gib
from host_steward.panes import Agents, Job, Pane, Proc

NAME = "memctl"
HELP = (
    "the memory controller: host memory and disk state, heavy-work admission, kernel kill records"
)


@dataclass(frozen=True)
class Tuning:
    tick_s: float
    offload_min: float
    outside_hog_min: float
    note_gap_s: float
    outside_hog_after_s: float
    guard_fresh_s: float
    cmdline_head: int
    cache_cmd_min: float
    recent_s: float
    counter_grace_s: float
    stop_match_s: float
    result_grace_s: float
    result_give_up_s: float
    tether_refresh_s: float
    disk_lines_refresh_s: float
    admission_margin_gib: float
    row_every_s: float

    @classmethod
    def from_cfg(cls, c: dict[str, Any]) -> Tuning:
        return cls(
            tick_s=float(c["tick_s"]),
            offload_min=float(c["offload_min_gib"]) * G,
            outside_hog_min=float(c["outside_hog_min_gib"]) * G,
            note_gap_s=float(c["note_gap_s"]),
            outside_hog_after_s=float(c["outside_hog_after_s"]),
            guard_fresh_s=float(c["guard_fresh_s"]),
            cmdline_head=int(c["cmdline_head"]),
            cache_cmd_min=float(c["cache_cmd_min_mib"]) * 2**20,
            recent_s=float(c["recent_s"]),
            counter_grace_s=float(c["counter_grace_s"]),
            stop_match_s=float(c["stop_match_s"]),
            result_grace_s=float(c["result_grace_s"]),
            result_give_up_s=float(c["result_give_up_s"]),
            tether_refresh_s=float(c["tether_refresh_s"]),
            disk_lines_refresh_s=float(c["disk_lines_refresh_s"]),
            admission_margin_gib=float(c["admission_margin_gib"]),
            row_every_s=float(c["row_every_s"]),
        )


@dataclass(frozen=True)
class Tether:
    """The owner's own Tether instance: its state dir (tether.db) and runtime dir (memory-guard.json)."""

    state_dir: Path
    runtime_dir: Path

    @property
    def db(self) -> Path:
        return self.state_dir / "tether.db"

    @property
    def guard(self) -> Path:
        return self.runtime_dir / "memory-guard.json"


def tether_sessions(db: Path) -> dict[str, str] | None:
    """pane scope -> Tether session id from a tether.db, opened read-only; None when it cannot be read."""
    with contextlib.suppress(sqlite3.Error, OSError):
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
        try:
            return {
                str(s): str(i)
                for i, s in con.execute(
                    "SELECT id, scope_unit FROM sessions WHERE scope_unit IS NOT NULL"
                )
            }
        finally:
            con.close()
    return None


def guard_age(guard: Path, now: float) -> float | None:
    """Seconds since Tether's memory guard last reported (memory-guard.json), None when unreadable."""
    try:
        doc = json.loads(guard.read_text())
    except (OSError, ValueError):
        return None
    ts = doc.get("ts") if isinstance(doc, dict) else None
    return now - float(ts) if isinstance(ts, int | float) and not isinstance(ts, bool) else None


def guard_candidate(guard: Path, now: float, fresh_s: float) -> bool:
    try:
        doc = json.loads(guard.read_text())
    except (OSError, ValueError):
        return False
    age = guard_age(guard, now)
    return (
        isinstance(doc, dict)
        and age is not None
        and age <= fresh_s
        and doc.get("kill_candidate") is True
    )


def write_atomic(path: Path, doc: dict) -> None:
    core.write_json(path, doc, dir_mode=0o755, compact=True)


class Controller:
    def __init__(
        self,
        uid: int,
        out: Path,
        lim: memstate.Limits,
        tune: Tuning,
        agents: Agents,
        proc: Path = Path("/proc"),
        sys_root: Path = Path("/sys"),
        *,
        events: Path,
        heartbeat: Path,
        tether: Tether | None = None,
        share: Path | None = None,
        run: core.Runner = core.run_command,
        offload: Callable[[], str | None] = lambda: None,
        only_scopes: Iterable[str] | None = None,
        now: float | None = None,
        disks: Iterable[str] = (),
        disk_lines: Callable[[], tuple[memstate.Lines, dict[str, int], float]] | None = None,
        statvfs: Callable[[str], os.statvfs_result] = os.statvfs,
    ) -> None:
        self.cg = sys_root / "fs/cgroup"
        self.app = self.cg / f"user.slice/user-{uid}.slice/user@{uid}.service/app.slice"
        self.uid, self.lim, self.tune, self.agents = uid, lim, tune, agents
        self.proc, self.out = proc, out
        self.events, self.heartbeat = events, heartbeat
        self.tether_paths = tether
        self.share = share  # /run/nightshift: the verdict's second home where Tether also reads it (live only)
        self.run, self.read_offload = run, offload
        self.only = frozenset(only_scopes) if only_scopes is not None else None
        self.state = "green"
        self.panes_seen: set[str] = set()
        self.offload: str | None = None
        self.offload_at = 0.0
        self.red_since: float | None = None
        self.noted: dict[tuple[str, str], float] = {}  # (kind, scope) -> last record
        self.counters: dict[str, tuple[int, int]] | None = None
        self.vm_oom_kill: int | None = None
        self.pending: list[
            dict[str, Any]
        ] = []  # kernel kills seen in counters, waiting for the journal
        # counted pane kills that got a counter-only record: their journal line, read later, says what was killed
        self.late: list[dict[str, Any]] = []
        start = now if now is not None else time.time()
        # journal kills at or before this were recorded by an earlier run
        self.journal_after = max(
            (
                float(r.get("ts") or 0)
                for r in memevents.read(self.events)
                if str(r.get("killer") or "").startswith("kernel-")
            ),
            default=start,
        )
        self.recorded: dict[
            tuple[int, float], dict[str, Any]
        ] = {}  # journal kills this run recorded, by (pid, ts)
        self.claimed: set[tuple[int, float]] = (
            set()
        )  # ... and those a counted kill has been matched to
        self.pane_gone: dict[str, float] = {}  # pane -> first tick it was missing
        self.pane_kill: dict[
            str, tuple[float, str, str]
        ] = {}  # pane -> (ts, killer, state) of its last kernel kill
        self.stopped: set[str] = (
            set()
        )  # panes with a pane-stopped record, or found to have ended cleanly
        self.stop_wait: set[str] = (
            set()
        )  # panes gone near a kernel kill, waiting for their unit's result
        self.pane_lost: dict[
            str, tuple[float, str]
        ] = {}  # pane -> (ts, root or agent) of a kernel kill of its own
        self.stop_agent: dict[
            str, str | None
        ] = {}  # waiting pane -> its agent (claude, codex) when it went
        self.recent: dict[
            int, dict[str, Any]
        ] = {}  # pid -> what the last snapshots knew, for kernel kill records
        self.tether: dict[str, str] = {}  # pane scope -> Tether session id
        self.tether_at = float("-inf")
        self.pane_bytes: dict[str, int] = {}  # pane -> anon + swap of its cgroup, this tick
        self.agent_cache: dict[tuple[int, int], bool] = {}  # (pid, starttime) -> is an agent binary
        self.disks, self.disk_lines, self.statvfs = list(disks), disk_lines, statvfs
        self.disk_prev: dict[str, str] = {}
        self.lines: tuple[memstate.Lines, dict[str, int], float] | None = None
        self.lines_at = float("-inf")
        self.lines_error: str | None = None
        self.records_written = (
            0  # event records this run wrote (to the dry-run file while acting is off)
        )

    def allowed(self, scope: str) -> bool:
        return self.only is None or scope in self.only

    def host_metrics(self) -> dict[str, float]:
        return memstate.metrics(
            (self.proc / "meminfo").read_text(), (self.proc / "pressure/memory").read_text()
        )

    def disk(self, now: float, commit: bool = True) -> dict[str, Any] | None:
        """The worst internal disk now (statvfs only), None with no disk to guard. commit keeps its state for the
        next tick's hysteresis."""
        if not self.disks or self.disk_lines is None:
            return None
        if self.lines is None or now - self.lines_at >= self.tune.disk_lines_refresh_s:
            try:
                self.lines, self.lines_error = self.disk_lines(), None
            except Exception as exc:  # noqa: BLE001 - keeps the last lines (none yet: no disk verdict); said once per failure streak
                if self.lines_error is None:
                    print(
                        f"memctl: disk lines unreadable ({type(exc).__name__}: {exc}); "
                        + ("keeping the last ones" if self.lines else "no disk verdict"),
                        flush=True,
                    )
                self.lines_error = str(exc)
            self.lines_at = now
        if self.lines is None:
            return None
        ln, ballast, margin = self.lines
        worst: dict[str, Any] | None = None
        for path in self.disks:
            d: dict[str, Any] = {
                "state": "unknown",
                "path": path,
                "free_bytes": None,
                "ballast_bytes": ballast.get(path, 0),
                "floor_bytes": int(max(ln.crit, ln.floor) * G),
                "warn_bytes": int(ln.warn * G),
            }
            with contextlib.suppress(
                OSError, ValueError
            ):  # unreadable: state unknown, the hysteresis state is kept
                st = self.statvfs(path)
                d["free_bytes"] = st.f_bavail * st.f_frsize  # df's Avail
                d["state"] = memstate.disk_state(
                    self.disk_prev.get(path, "green"),
                    d["free_bytes"],
                    d["ballast_bytes"],
                    ln,
                    margin,
                )
                if commit:
                    self.disk_prev[path] = d["state"]
            if worst is None or memstate.rank(d["state"]) > memstate.rank(worst["state"]):
                worst = d
        return worst

    def pane_dirs(self) -> list[Path]:
        with contextlib.suppress(OSError):
            return [d for d in self.app.glob("tmux-spawn-*.scope") if self.allowed(d.name)]
        return []

    def agent_of(self, p: Proc, seed: bool) -> bool:
        """Is p an agent (claude, codex, codex-real)? The command line is read once per process and cached. On red
        it is read only for a direct child of the pane's root: reading a thrashing process's command line can stall
        memctl, and an agent's own agent children are named claude or codex anyway."""
        key = (p.pid, p.starttime)
        if key in self.agent_cache:
            return self.agent_cache[key]
        if p.comm in self.agents.comms:
            verdict = True
        elif self.state == "red" and not seed:
            return False  # not cached: asked again once memory is not critical
        else:
            verdict = panes.is_agent(p.comm, panes.argv(self.proc, p.pid), self.agents)
        self.agent_cache[key] = verdict
        return verdict

    def snapshot(self) -> tuple[dict[str, Pane], dict[int, Proc]]:
        """(panes, run-*.scope processes), from cgroup.procs and /proc."""
        found = {}
        seen: set[tuple[int, int]] = set()
        for d in self.pane_dirs():
            procs = {
                pid: p
                for pid in panes.cgroup_pids(d)
                if (p := panes.read_proc(self.proc, pid, d.name))
            }
            found[d.name] = panes.make_pane(d.name, procs, self.proc, self.agents, self.agent_of)
            seen.update((p.pid, p.starttime) for p in procs.values())
        self.agent_cache = {k: v for k, v in self.agent_cache.items() if k in seen}
        runs = {}
        with contextlib.suppress(OSError):
            for d in self.app.glob("run-*.scope"):
                runs.update(
                    {
                        pid: p
                        for pid in panes.cgroup_pids(d)
                        if (p := panes.read_proc(self.proc, pid, d.name))
                    }
                )
        return found, runs

    def outside_units(self, exclude: set[str]) -> list[tuple[str, int]]:
        """Units outside the panes by RSS anon + swap, largest first (system.slice, app.slice, session.slice)."""
        out = []
        for base in (self.cg / "system.slice", self.app, self.app.parent / "session.slice"):
            with contextlib.suppress(OSError):
                for d in base.iterdir():
                    if not d.is_dir() or d.name in exclude or d.name.startswith("tmux-spawn-"):
                        continue
                    with contextlib.suppress(OSError, ValueError):
                        swap = 0
                        with contextlib.suppress(OSError, ValueError):
                            swap = int((d / "memory.swap.current").read_text())
                        out.append(
                            (d.name, memstate.anon_bytes((d / "memory.stat").read_text()) + swap)
                        )
        return sorted(out, key=lambda x: -x[1])

    # records

    def emit(
        self, kind: str, now: float, host_state: str | None = None, **fields: Any
    ) -> dict[str, Any]:
        scope = fields.get("scope")
        rec = memevents.record(
            kind,
            now,
            tether_session_id=self.tether.get(scope) if scope else None,
            host_state=host_state or self.state,
            **fields,
        )
        shared = self.share / "memory-events.jsonl" if self.share and self.share.is_dir() else None
        for path in (self.events, shared):
            if path is not None:
                with contextlib.suppress(OSError):
                    memevents.append(path, rec)
        self.records_written += 1
        return rec

    def due(self, kind: str, scope: str, now: float) -> bool:
        if now - self.noted.get((kind, scope), float("-inf")) < self.tune.note_gap_s:
            return False
        self.noted[(kind, scope)] = now
        return True

    # per-tick steps

    def remember(self, found: dict[str, Pane], jobs: list[Job], now: float) -> None:
        for pane in found.values():
            for pid in pane.protected:
                if pid in pane.procs:  # the root shell is the pane itself: its loss is the pane's
                    self._remember(
                        pane.procs[pid],
                        pane.scope,
                        "agent" if pid in pane.agents else "container",
                        now,
                    )
        for job in jobs:
            for p in job.members:
                self._remember(p, job.scope, "tool", now)
        # a pane still waiting for its kill's journal line keeps what was known of its processes, to class that kill
        hold = self.stop_wait | {str(p["scope"]) for p in self.pending + self.late}
        for pid in [
            k
            for k, v in self.recent.items()
            if now - v["seen"] > self.tune.recent_s and v["scope"] not in hold
        ]:
            del self.recent[pid]

    def _remember(self, p: Proc, scope: str, cls: str, now: float) -> None:
        old = self.recent.get(p.pid)
        cmd = old["cmdline_head"] if old and old["starttime"] == p.starttime else None
        if (
            cmd is None
            and self.state != "red"
            and (p.bytes >= self.tune.cache_cmd_min or cls != "tool")
        ):
            cmd = panes.cmdline_head(self.proc, p.pid, self.tune.cmdline_head)
        self.recent[p.pid] = {
            "starttime": p.starttime,
            "comm": p.comm,
            "cmdline_head": cmd,
            "scope": scope,
            "class": cls,
            "seen": now,
        }

    def detect_kills(self, now: float) -> None:
        """Kernel OOM kills from counters: per-unit memory.events oom_kill under app.slice and /proc/vmstat."""
        cur: dict[str, tuple[int, int]] = {}
        with contextlib.suppress(OSError):
            cur["app.slice"] = panes.oom_counters((self.app / "memory.events").read_text())
            for d in self.app.iterdir():
                with contextlib.suppress(OSError, ValueError):
                    cur[d.name] = panes.oom_counters((d / "memory.events").read_text())
        vm = None
        with contextlib.suppress(OSError, ValueError):
            vm = panes.vmstat_oom_kill((self.proc / "vmstat").read_text())
        prev, prev_vm = self.counters, self.vm_oom_kill
        self.counters, self.vm_oom_kill = cur, vm
        if prev is None:
            return
        app_cur, app_prev = cur.get("app.slice", (0, 0)), prev.get("app.slice", (0, 0))
        app_oom = app_cur[0] > app_prev[0]
        attributed = 0
        for name, (oom, kills) in cur.items():
            if name == "app.slice" or name not in prev or kills <= prev[name][1]:
                continue
            pane = name.startswith("tmux-spawn-")
            killer = (
                ("kernel-pane-cap" if pane else "kernel-cgroup")
                if oom > prev[name][0]
                else ("kernel-cgroup" if app_oom else "kernel-global")
            )
            self.pending.append(
                {
                    "ts": now,
                    "scope": name,
                    "n": kills - prev[name][1],
                    "killer": killer,
                    "state": self.state,
                }
            )
            attributed += kills - prev[name][1]
        rest = max(app_cur[1] - app_prev[1] - attributed, 0)  # in app.slice, unit already gone
        if vm is not None and prev_vm is not None:
            rest += max(vm - prev_vm - (app_cur[1] - app_prev[1]), 0)  # outside app.slice
        if rest:
            self.pending.append(
                {
                    "ts": now,
                    "scope": None,
                    "n": rest,
                    "killer": "kernel-global",
                    "state": self.state,
                }
            )

    def resolve_kills(self, now: float) -> None:
        """Write kill records for counted kernel kills, with details from the kernel journal.

        Every new journal kill is recorded once (by pid and time). Each counted kill (pending) is then matched to an
        unmatched journal kill in its unit, oldest first; one still unmatched counter_grace_s after it was counted
        gets a counter-only record. A counter-only kill in a pane (late) keeps reading the journal for
        result_give_up_s: its line, when it comes, is recorded with late=True (it details that counter-only record,
        it is no second kill) and with its class, so a pane that lost its root shell or agent is still told."""
        self.late = [p for p in self.late if now - p["ts"] <= self.tune.result_give_up_s]
        if not self.pending and not self.late:
            return
        lines = memevents.journal_kernel(
            min(p["ts"] for p in self.pending + self.late) - 3 * self.tune.tick_s, self.run
        )
        new = []
        for k in memevents.parse_kernel(lines or []):
            key = (k["pid"], k["ts"])
            if k["ts"] <= self.journal_after or key in self.recorded:
                continue
            self.recorded[key] = k
            new.append(k)
        free = sorted(
            (k for key, k in self.recorded.items() if key not in self.claimed),
            key=lambda k: k["ts"],
        )
        units = self.counters or {}

        def claim(p: dict[str, Any]) -> list[dict[str, Any]]:
            got = []
            for k in free:
                # an unattributed count (outside app.slice, or a unit already gone) never takes a live unit's kill
                ours = (
                    k["scope"] == p["scope"] if p["scope"] is not None else k["scope"] not in units
                )
                if (
                    p["n"]
                    and ours
                    and k["ts"] >= p["ts"] - 3 * self.tune.tick_s
                    and (k["pid"], k["ts"]) not in self.claimed
                ):
                    self.claimed.add((k["pid"], k["ts"]))
                    p["n"] -= 1
                    got.append(k)
            return got

        late: set[tuple[int, float]] = set()
        if lines is not None:
            for p in self.late:  # older counts first: their records were already written
                late.update((k["pid"], k["ts"]) for k in claim(p))
            self.late = [p for p in self.late if p["n"]]
        keep, counted = [], []
        for p in sorted(
            self.pending, key=lambda p: (p["scope"] is None, p["ts"])
        ):  # unit counts first
            claim(p)
            if not p["n"]:
                continue
            if now - p["ts"] < self.tune.counter_grace_s:
                keep.append(p)
            elif (
                p["scope"] is not None or lines is None
            ):  # unattributed counts with the journal read: nothing to add
                counted.append(p)
        self.pending = keep
        for k in new:
            seen = self.recent.get(k["pid"], {})
            scope = k["scope"]
            cls = seen.get("class") or (
                "tool" if scope and scope.startswith(("tmux-spawn-", "run-")) else "container"
            )
            state = next((p["state"] for p in self.pending if p["scope"] == scope), self.state)
            self._kernel_record(
                k["ts"],
                scope,
                k["killer"],
                state,
                pid=k["pid"],
                starttime=seen.get("starttime"),
                comm=k["comm"],
                cmdline_head=seen.get("cmdline_head"),
                bytes=k["bytes"],
                cls=cls,
                **({"late": True} if (k["pid"], k["ts"]) in late else {}),
            )
        for p in counted:
            pane = bool(p["scope"] and p["scope"].startswith("tmux-spawn-"))
            cls = "tool" if pane or (p["scope"] or "").startswith("run-") else "container"
            if pane:
                self.late.append(dict(p))
            self._kernel_record(
                p["ts"],
                p["scope"],
                p["killer"],
                p["state"],
                cls=cls,
                count=p["n"],
                source="counter",
            )
        for key in [key for key, k in self.recorded.items() if now - k["ts"] > 3600]:
            del self.recorded[key]
            self.claimed.discard(key)

    def _kernel_record(
        self, ts: float, scope: str | None, killer: str, state: str, *, cls: str, **fields: Any
    ) -> None:
        self.emit("kill", ts, state, killer=killer, scope=scope, **{"class": cls}, **fields)
        if scope and scope.startswith("tmux-spawn-"):
            self.pane_kill[scope] = (ts, killer, state)
            if cls in ("container", "agent"):  # the root shell (the pane itself) or its agent
                self.pane_lost[scope] = (ts, "root" if cls == "container" else "agent")
            self.check_stopped(scope)

    def check_stopped(self, scope: str) -> None:
        """A pane gone within stop_match_s of a kernel kill in it may have been stopped by it, whichever is seen last.
        It waits for the unit's result (resolve_stopped): a pane the owner or its agent ended cleanly after a tool
        kill is no loss."""
        kill, gone = self.pane_kill.get(scope), self.pane_gone.get(scope)
        if (
            kill is None
            or gone is None
            or abs(gone - kill[0]) > self.tune.stop_match_s
            or scope in self.stopped
            or not self.allowed(scope)
        ):
            return
        if scope not in self.stop_wait:
            self.stop_agent[scope] = self.agent_tool(
                scope
            )  # as it was when it went: recent forgets it later
        self.stop_wait.add(scope)

    def resolve_stopped(self, now: float) -> None:
        """One pane-stopped record for each waiting pane the kernel took its root shell or agent from (lost), or whose
        unit failed (oom-kill, signal) in the user manager's journal; one with neither result_grace_s after it went
        ended cleanly and gets none. Never on red (the journal read forks)."""
        for scope in sorted(self.stop_wait):
            kill, gone = self.pane_kill.get(scope), self.pane_gone.get(scope)
            if kill is None or gone is None:
                self.stop_wait.discard(scope)
                self.stop_agent.pop(scope, None)
                continue
            lost = self.pane_lost.get(scope)
            proof: dict[str, Any] = (
                {"lost": lost[1]} if lost and abs(gone - lost[0]) <= self.tune.stop_match_s else {}
            )
            read = True
            if not proof:
                read, result = memevents.unit_result(
                    scope, min(kill[0], gone) - self.tune.stop_match_s, self.run
                )
                if read and result in memevents.FAILED_RESULTS:
                    proof = {"unit_result": result}
            if proof:
                self.stop_wait.discard(scope)
                self.stopped.add(scope)
                agent = self.stop_agent.pop(scope, None) or self.agent_tool(scope)
                self.emit(
                    "pane-stopped",
                    kill[0],
                    kill[2],
                    killer=kill[1],
                    scope=scope,
                    agent=agent,
                    **proof,
                    **{"class": "container"},
                )
            elif any(p["scope"] == scope for p in self.late):
                continue  # a kill in it is known only from its counter: what it took is still to come from the journal
            elif now - gone >= (self.tune.result_grace_s if read else self.tune.result_give_up_s):
                self.stop_wait.discard(scope)
                self.stop_agent.pop(scope, None)
                self.stopped.add(
                    scope
                )  # ended cleanly (or no proof): never a pane-stopped record for this pane

    def agent_tool(self, scope: str) -> str | None:
        """claude or codex: the agent last seen in the pane, so the owner's push can give the resume command."""
        for v in self.recent.values():
            if v["scope"] == scope and v["class"] == "agent":
                words = f"{v['comm']} {v['cmdline_head'] or ''}"
                for tool in ("codex", "claude"):
                    if tool in words:
                        return tool
        return None

    def refresh_tether(self, now: float, force: bool = False) -> None:
        if self.tether_paths is None or (
            not force and now - self.tether_at < self.tune.tether_refresh_s
        ):
            return
        self.tether_at = now
        if (
            got := tether_sessions(self.tether_paths.db)
        ) is not None:  # a db that cannot be read now keeps what it had
            self.tether = got

    def guard_has_candidate(self, now: float) -> bool:
        """Tether's memory guard is alive and has an agent tool job it may stop: no outside-hog yet."""
        return self.tether_paths is not None and guard_candidate(
            self.tether_paths.guard, now, self.tune.guard_fresh_s
        )

    def note_outside(self, now: float, outside_runs: list[Proc]) -> None:
        if now - (
            self.red_since or now
        ) < self.tune.outside_hog_after_s or self.guard_has_candidate(now):
            return
        run_bytes: dict[str, int] = {}
        for p in outside_runs:
            run_bytes[p.unit] = run_bytes.get(p.unit, 0) + p.bytes
        units = self.outside_units(set(run_bytes)) + list(run_bytes.items())
        top = max(units, key=lambda u: u[1], default=None)
        # only when it is the biggest user: a bigger pane (its agent, or tools under 1 GiB each) is the agent-hog case
        biggest_pane = max(self.pane_bytes.values(), default=0)
        if (
            top
            and top[1] >= self.tune.outside_hog_min
            and top[1] > biggest_pane
            and self.due("outside-hog", top[0], now)
        ):
            # the biggest users, panes included, so the owner's push names them without a terminal
            users = sorted({**self.pane_bytes, **dict(units)}.items(), key=lambda u: -u[1])[:4]
            self.emit(
                "outside-hog",
                now,
                scope=top[0],
                bytes=top[1],
                top=[[u, b] for u, b in users],
                **{"class": "container"},
            )
            print(
                "memctl: memory critical and Tether has no agent tool job to stop; "
                f"biggest user outside the panes: {top[0]} ({gib(top[1])}), not killed",
                flush=True,
            )

    def tick(self, now: float) -> dict[str, Any]:
        t0 = time.monotonic()
        m = self.host_metrics()
        self.state = memstate.classify(self.state, m, self.lim)
        self.red_since = (self.red_since or now) if self.state == "red" else None
        found, runs = self.snapshot()
        jobs, outside_runs = panes.build_jobs(found, runs)
        self.pane_bytes = {}
        for d in self.pane_dirs():
            with contextlib.suppress(OSError, ValueError):
                anon = memstate.anon_bytes((d / "memory.stat").read_text())
                swap = 0
                with contextlib.suppress(OSError, ValueError):
                    swap = int((d / "memory.swap.current").read_text())
                self.pane_bytes[d.name] = anon + swap
        for gone in self.panes_seen - found.keys():
            self.pane_gone[gone] = now
            self.check_stopped(gone)
        self.panes_seen = set(found)
        for name in [n for n, t in self.pane_gone.items() if now - t > 3600 or n in found]:
            del self.pane_gone[name]
            self.pane_kill.pop(name, None)
            self.pane_lost.pop(name, None)
            self.stopped.discard(name)
            self.stop_wait.discard(name)
            self.stop_agent.pop(name, None)
        for name in [
            n for n, k in self.pane_kill.items() if now - k[0] > 3600 and n not in self.pane_gone
        ]:
            del self.pane_kill[name]
            self.pane_lost.pop(name, None)
        self.remember(found, jobs, now)
        self.detect_kills(now)
        if self.state != "red":  # forks and the sqlite read wait until memory is not critical
            self.refresh_tether(now)
            self.resolve_kills(now)
            self.resolve_stopped(now)
        if (
            self.state == "red"
        ):  # agent tool jobs are Tether's to stop; memctl only names a hog outside the panes
            self.note_outside(now, outside_runs)
        if now - self.offload_at >= 60:
            self.offload, self.offload_at = self.read_offload(), now
        disk = self.disk(now)
        doc = memstate.admission(self.state, m, now, self.offload, self.lim, disk)
        doc["throttled"] = []  # contract v1 field; memctl no longer throttles
        write_atomic(self.out, doc)
        if self.share is not None and self.share.is_dir():  # the same verdict where Tether reads it
            with contextlib.suppress(OSError):
                write_atomic(self.share / "admission.json", doc)
        write_atomic(
            self.heartbeat,
            {
                "v": 1,
                "ts": int(now),
                "pid": os.getpid(),
                "state": self.state,
                "disk": disk["state"] if disk else None,
                "red_since": int(self.red_since) if self.red_since else None,
                "tick_ms": round((time.monotonic() - t0) * 1000),
            },
        )
        return doc

    def preview(self) -> dict[str, Any]:
        """The host state and what memctl sees in the panes now, writing nothing."""
        m = self.host_metrics()
        state = memstate.classify(self.state, m, self.lim)
        found, runs = self.snapshot()
        jobs, outside_runs = panes.build_jobs(found, runs)

        def job_doc(j: Job) -> dict[str, Any]:
            return {
                "scope": j.scope,
                "key": list(j.key),
                "bytes": j.bytes,
                "members": len(j.members),
                "pid": j.top.pid,
                "comm": j.top.comm,
                "cmdline_head": panes.cmdline_head(self.proc, j.top.pid, self.tune.cmdline_head),
            }

        run_bytes: dict[str, int] = {}
        for p in outside_runs:
            run_bytes[p.unit] = run_bytes.get(p.unit, 0) + p.bytes
        outside = sorted(
            self.outside_units(set(run_bytes)) + list(run_bytes.items()), key=lambda u: -u[1]
        )
        self.refresh_tether(time.time(), force=True)
        t = self.tether_paths
        tether = (
            None
            if t is None
            else {
                "sessions": len(got) if (got := tether_sessions(t.db)) is not None else None,
                "guard_age_s": round(a, 1)
                if (a := guard_age(t.guard, time.time())) is not None
                else None,
            }
        )
        disk = self.disk(time.time(), commit=False)
        pub = memstate.admission(state, m, time.time(), None, self.lim, disk)
        return {
            "state": pub["state"],
            "reason": pub["reason"],
            "memory_state": state,
            "disk": f"{disk['state']} ({memstate.disk_reason(disk)})" if disk else None,
            "tether": tether,
            "top_jobs": [job_doc(j) for j in jobs[:5]],
            "agents": {
                s: {"pids": sorted(p.agents), "root": p.root, "bytes": p.agent_bytes}
                for s, p in sorted(found.items())
            },
            "outside_top": outside[:3],
        }


# --- wiring ----------------------------------------------------------------------------------------------------


def expand(template: str, runtime: str, home: str) -> Path:
    return Path(template.format(runtime=runtime, home=home))


def read_ballast(path: Path) -> dict[str, int]:
    """Ballast the space guard holds per disk path (its state file), released before the reserve is reached."""
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    ballast = doc.get("ballast") if isinstance(doc, dict) else None
    return (
        {k: int(v) for k, v in (ballast or {}).items() if isinstance(v, int | float)}
        if isinstance(ballast, dict)
        else {}
    )


def read_offload(state_file: Path, min_bytes: float) -> str | None:
    """The PVE host when the pve check last saw it reachable with enough free RAM (checks.pve.offload in the state file)."""
    try:
        doc = json.loads(state_file.read_text())
        entry = doc["checks"]["pve"]["offload"]
        if float(entry["mem_available_gib"]) * G >= min_bytes:
            return str(entry["host"]) or None
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return None


def ballast_file(data: dict[str, Any]) -> Path:
    """The space guard's record that says what ballast it holds. [acting] space_guard is the cutover flag: host-steward's
    own file once its guard acts, Nightshift's while Nightshift's guard does."""
    paths = data["memctl"]["paths"]
    return Path(paths["ballast_state_own" if core.acting(data, "space_guard") else "ballast_state"])


def build(data: dict[str, Any], acting: bool, uid: int, home: str, runtime: str) -> Controller:
    cfg = data["memctl"]
    paths = cfg["paths"]
    tune = Tuning.from_cfg(cfg)
    kind = "live" if acting else "dry"
    storage_cfg = data["checks"]["storage"]
    disks = [
        d["path"]
        for d in storage_cfg["disks"]
        if d.get("balance") and str(d.get("path", "")).startswith("/")
    ]
    ballast_path = ballast_file(data)
    state_file = Path(paths["state_file"])
    ln = memstate.lines(storage_cfg)

    def disk_lines() -> tuple[memstate.Lines, dict[str, int], float]:
        return ln, read_ballast(ballast_path), tune.admission_margin_gib

    return Controller(
        uid,
        expand(paths[f"{kind}_admission"], runtime, home),
        memstate.Limits.from_cfg(cfg),
        tune,
        Agents(frozenset(cfg["agent_comms"]), frozenset(cfg["agent_bins"])),
        events=expand(paths[f"{kind}_events"], runtime, home),
        heartbeat=expand(paths[f"{kind}_heartbeat"], runtime, home),
        tether=Tether(
            expand(paths["tether_state"], runtime, home),
            expand(paths["tether_runtime"], runtime, home),
        ),
        share=Path(paths["shared_dir"]) if acting else None,
        offload=lambda: read_offload(state_file, tune.offload_min),
        disks=disks,
        disk_lines=disk_lines,
    )


def status_row(
    ctl: Controller,
    doc: dict[str, Any],
    acting: bool,
    machine: str,
    now: float,
    refused: str | None = None,
) -> dict[str, Any]:
    disk = doc["disk"]["state"] if doc.get("disk") else "not guarded"
    facts = f"memory {ctl.state}, disk {disk}"
    state = "ok"
    if refused:
        state, text = "warn", f"{refused} Meanwhile a dry run: {facts}."
    elif acting:
        text = f"Running: {facts}. Publishing admission and kill records."
    else:
        text = (
            f'Dry run: {facts}. Would publish admission "{doc["state"]}"'
            f" ({'admit' if doc['admit'] else 'defer heavy work'}) and write {ctl.records_written} kill record(s);"
            " writing only its own files."
        )
    every = ctl.tune.row_every_s / 60
    return core.job_row(
        "memctl",
        "Memory controller",
        state,
        text,
        machine,
        now,
        every,
        every,
        kind="service",
        actions=[{"kind": "log", "ref": "journalctl --user -u host-steward-memctl.service"}],
    )


def print_preview(doc: dict[str, Any]) -> None:
    print(f"memctl preview (reads only): {doc['state']}: {doc['reason']}")
    print(
        f"  memory {doc['memory_state']}, disk {doc['disk'].split(' (')[0] if doc['disk'] else 'not guarded'}"
    )
    if (t := doc["tether"]) is not None:
        sessions = (
            "db unreadable" if t["sessions"] is None else f"{t['sessions']} sessions in panes"
        )
        guard = (
            "guard not reporting"
            if t["guard_age_s"] is None
            else f"guard reported {t['guard_age_s']:.0f}s ago"
        )
        print(f"  tether: {sessions}, {guard}")
    print("agent tool jobs are Tether's to stop (tether memory guard); the biggest now:")
    if not doc["top_jobs"]:
        print("  none")
    for j in doc["top_jobs"]:
        print(
            f"  job {j['comm']} pid {j['pid']} {gib(j['bytes'])} x{j['members']} {j['key'][0]}={j['key'][1]} {j['scope']}"
        )
    for scope, a in doc["agents"].items():
        print(
            f"  pane {scope}: root {a['root']}, agent {a['pids'] or 'none found'} {gib(a['bytes'])}"
        )
    for name, n in doc["outside_top"]:
        print(f"  outside the panes: {name} {gib(n)}")


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--once", action="store_true", help="one tick, then exit")
    parser.add_argument(
        "--preview", action="store_true", help="print what memctl sees and write nothing"
    )


def main(
    args: argparse.Namespace, data: dict[str, Any], post: Callable[..., bool] = aico_status.report
) -> int:
    wanted = core.acting(data, "memctl")
    refused = core.refusal(data, "memctl", core.run_command) if wanted else None
    acting = wanted and not refused  # stands down (dry run, warn row) while Nightshift's memctl runs
    uid = os.getuid()
    home = str(Path.home())
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{uid}"
    ctl = build(data, acting, uid, home, runtime)
    if args.preview:
        print_preview(ctl.preview())
        return 0
    machine = aico_status.machine_id()
    last_state, last_row = None, float("-inf")
    print(f"memctl: {'acting' if acting else 'dry run'}; writing {ctl.out}", flush=True)
    if refused:
        print(f"memctl: {refused}", flush=True)
    while True:
        now = time.time()
        doc = ctl.tick(now)
        if doc["state"] != last_state:
            print(f"memctl: {doc['state']}: {doc['reason']}", flush=True)
        if doc["state"] != last_state or now - last_row >= ctl.tune.row_every_s:
            post(status_row(ctl, doc, acting, machine, now, refused))
            last_row = now
            if wanted and bool(core.refusal(data, "memctl", core.run_command)) != bool(refused):
                print("memctl: Nightshift's memctl changed; restarting to follow it", flush=True)
                return 0  # the unit restarts it with the right mode
        last_state = doc["state"]
        if args.once:
            return 0
        time.sleep(ctl.tune.tick_s)
