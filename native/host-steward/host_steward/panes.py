"""Agent panes, their agents and tool jobs, read from /proc and cgroups (read-only): what memctl can see.

Port of the process part of ns/memctl.py. A pane is a tmux-spawn-*.scope under the owner's app.slice; its root
shell is the process whose parent is outside the scope and is not the user manager; an agent is a claude/codex the
root shell started. Everything else in the pane (and in run-*.scope units whose parent chain reaches a pane) is a
tool job. memctl signals and freezes nothing: Tether's memory guard acts on the jobs.
"""

from __future__ import annotations

import contextlib
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import NamedTuple


class Agents(NamedTuple):
    comms: frozenset[str]  # process names that are an agent
    bins: frozenset[str]  # program names (first two argv words) that are an agent


@dataclass(frozen=True)
class Proc:
    pid: int
    ppid: int
    pgid: int
    sid: int
    starttime: (
        int  # clock ticks since boot (/proc/PID/stat field 22): with the pid, the process identity
    )
    comm: str
    bytes: int  # RssAnon + VmSwap
    adj: int | None
    unit: str  # the pane or run-*.scope it was found in


@dataclass
class Pane:
    scope: str
    procs: dict[int, Proc]
    root: int | None = None  # the pane's root shell
    agents: frozenset[int] = (
        frozenset()
    )  # claude/codex started by the root shell, and their own agent children

    @property
    def protected(self) -> frozenset[int]:
        return self.agents | ({self.root} if self.root is not None else set())

    @property
    def agent_bytes(self) -> int:
        return sum(self.procs[p].bytes for p in self.agents if p in self.procs)


@dataclass
class Job:
    scope: str  # the pane the job belongs to
    key: tuple[str, int]  # ("sid", session id) or ("tree", top pid under the agent)
    members: list[Proc] = field(default_factory=list)

    @property
    def bytes(self) -> int:
        return sum(p.bytes for p in self.members)

    @property
    def top(self) -> Proc:
        """The biggest member: the process a record names (the python, not the tool shell that started it)."""
        return max(self.members, key=lambda p: (p.bytes, -p.pid))


def read_stat(proc: Path, pid: int) -> tuple[str, int, int, int, int] | None:
    """(comm, ppid, pgid, sid, starttime) from /proc/PID/stat, None when the process is gone."""
    try:
        s = (proc / str(pid) / "stat").read_text()
        i = s.rindex(")")
        f = s[i + 2 :].split()
        return s[s.index("(") + 1 : i], int(f[1]), int(f[2]), int(f[3]), int(f[19])
    except (OSError, ValueError, IndexError):
        return None


def read_proc(proc: Path, pid: int, unit: str) -> Proc | None:
    st = read_stat(proc, pid)
    if st is None:
        return None
    kb = {}
    with contextlib.suppress(OSError):
        for line in (proc / str(pid) / "status").read_text().splitlines():
            k, _, v = line.partition(":")
            if k in ("RssAnon", "VmSwap"):
                kb[k] = int(v.split()[0])
    adj = None
    with contextlib.suppress(OSError, ValueError):
        adj = int((proc / str(pid) / "oom_score_adj").read_text())
    return Proc(
        pid,
        st[1],
        st[2],
        st[3],
        st[4],
        st[0],
        (kb.get("RssAnon", 0) + kb.get("VmSwap", 0)) * 1024,
        adj,
        unit,
    )


def argv(proc: Path, pid: int) -> list[str]:
    try:
        return (proc / str(pid) / "cmdline").read_bytes().decode(errors="replace").split("\0")[:-1]
    except OSError:
        return []


def cmdline_head(proc: Path, pid: int, limit: int) -> str | None:
    return " ".join(argv(proc, pid))[:limit] or None


def comm_of(proc: Path, pid: int) -> str:
    try:
        return (proc / str(pid) / "comm").read_text().strip()
    except OSError:
        return ""


def is_agent(comm: str, args: list[str], agents: Agents) -> bool:
    return comm in agents.comms or any(os.path.basename(a) in agents.bins for a in args[:2])


def cgroup_pids(d: Path) -> list[int]:
    out = []
    for dirpath, _dirs, files in os.walk(d):
        if "cgroup.procs" in files:
            with contextlib.suppress(OSError, ValueError):
                out += [int(x) for x in Path(dirpath, "cgroup.procs").read_text().split()]
    return out


def make_pane(
    scope: str,
    procs: dict[int, Proc],
    proc: Path,
    agents: Agents,
    agent_of: Callable[[Proc, bool], bool] | None = None,
) -> Pane:
    """Find the root shell and the agent processes of one pane.

    An agent is a claude/codex the root shell started (in any process group: an interactive shell gives each
    foreground job its own), or an agent child of an agent in that agent's process group (codex-real -> codex).
    Codex tools run in their own process groups, so a `codex exec` tool stays a tool. With no root shell (it died
    and the agent was reparented), every agent process in the pane is protected: in a pane memctl cannot read,
    sparing a tool is better than killing the agent. agent_of(p, seed) decides; seed is True for a direct child of
    the root (or a process whose parent is outside)."""
    check = agent_of or (lambda p, _seed: is_agent(p.comm, argv(proc, p.pid), agents))
    pane = Pane(scope, procs)
    roots = [
        p for p in procs.values() if p.ppid not in procs and comm_of(proc, p.ppid) != "systemd"
    ]
    root = min(roots, key=lambda p: (p.starttime, p.pid)) if roots else None
    if root is not None:
        seeds = [p for p in procs.values() if p.ppid == root.pid and check(p, True)]
    else:
        seeds = [p for p in procs.values() if check(p, p.ppid not in procs)]
    found = {p.pid for p in seeds}
    frontier = list(seeds)
    while frontier:
        parent = frontier.pop()
        for p in procs.values():
            if (
                p.ppid == parent.pid
                and p.pgid == parent.pgid
                and p.pid not in found
                and check(p, False)
            ):
                found.add(p.pid)
                frontier.append(p)
    pane.root, pane.agents = (root.pid if root else None), frozenset(found)
    return pane


def build_jobs(panes: dict[str, Pane], runs: dict[int, Proc]) -> tuple[list[Job], list[Proc]]:
    """Group every unprotected pane process, and every run-*.scope process whose parent chain reaches a pane, into
    tool jobs. Returns (jobs, run-scope processes that belong to no pane)."""
    allp: dict[int, Proc] = dict(runs)
    owner: dict[int, str] = {}
    for pane in panes.values():
        allp.update(pane.procs)
        owner.update(dict.fromkeys(pane.procs, pane.scope))

    def pane_of(pid: int) -> str | None:
        seen = 0
        while pid in allp and seen < 64:
            if pid in owner:
                return owner[pid]
            pid, seen = allp[pid].ppid, seen + 1
        return None

    groups: dict[tuple[str, tuple[str, int]], Job] = {}
    outside = []
    for pid, p in allp.items():
        scope = pane_of(pid)
        if scope is None:
            outside.append(p)
            continue
        pane = panes[scope]
        if pid in pane.protected:
            continue
        root_sid = pane.procs[pane.root].sid if pane.root is not None else None
        if p.sid != root_sid:
            key = ("sid", p.sid)
        else:  # shares the agent's session (Codex tools, MCP servers): the tree under one agent child
            top = p
            while (
                top.ppid in allp
                and top.ppid not in pane.protected
                and allp[top.ppid].sid == root_sid
            ):
                top = allp[top.ppid]
            key = ("tree", top.pid)
        groups.setdefault((scope, key), Job(scope, key)).members.append(p)
    return sorted(groups.values(), key=lambda j: (-j.bytes, j.key)), outside


def oom_counters(text: str) -> tuple[int, int]:
    """memory.events -> (oom, oom_kill)."""
    kv = dict(line.split() for line in text.splitlines() if len(line.split()) == 2)
    return int(kv.get("oom", 0)), int(kv.get("oom_kill", 0))


def vmstat_oom_kill(text: str) -> int:
    for line in text.splitlines():
        k, _, v = line.partition(" ")
        if k == "oom_kill":
            return int(v)
    return 0
