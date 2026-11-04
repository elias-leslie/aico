"""memctl (controller, state, panes, event record) and the memory check, on fixture /proc, /sys and journals."""

from __future__ import annotations

import copy
import json
import os
import shutil
import sqlite3
from argparse import Namespace

import pytest

from host_steward import core, memalerts, memevents, memstate, panes
from host_steward.checks import memory
from host_steward.jobs import memctl

DATA = core.load_data()
LIM = memstate.Limits.from_cfg(DATA["memctl"])
TUNE = memctl.Tuning.from_cfg(DATA["memctl"])
AGENTS = panes.Agents(
    frozenset(DATA["memctl"]["agent_comms"]), frozenset(DATA["memctl"]["agent_bins"])
)
LINES = memstate.Lines(
    reserve=25, warn=40, crit=30, floor=10
)  # the storage check's lines at reserve 25 GiB
G = memstate.G
UID = 1001
TMUX, MANAGER = 50, 2  # the tmux server and the user manager: parents outside every pane
Result = core.Result


def m(avail_g, swap=0.0, some=0.0, full=0.0):
    return {"avail": avail_g * G, "swap_pct": swap, "psi_some_avg60": some, "psi_full_avg10": full}


def classify(prev, metrics):
    return memstate.classify(prev, metrics, LIM)


def test_limits_come_from_the_data_file():
    assert LINES == memstate.lines(DATA["checks"]["storage"])
    assert LIM.amber_avail == 8 * G and LIM.red_avail == 3 * G and LIM.expires_s == 30


def test_reason_marks_swap_classify_ignores():
    # 2026-10-29: amber at 8 GiB read "swap 100%", so the owner took full idle swap for the cause
    assert "swap 100% (parked, no stalls), memory PSI 0.0" in memstate.reason(
        "amber", m(7.9, swap=100), LIM
    )
    assert "swap 100%, memory PSI 4.0" in memstate.reason("amber", m(7.9, swap=100, some=4), LIM)


def test_classify_thresholds_and_hysteresis():
    assert classify("green", m(16)) == "green"
    assert classify("green", m(7.9)) == "amber"
    assert classify("green", m(11, swap=76, some=2)) == "amber"
    # full swap with no memory stalls is parked pages (11 GiB free, PSI 0 held amber 37 min on 2026-10-28)
    assert classify("green", m(11, swap=96)) == "green"
    assert classify("amber", m(11, swap=96)) == "green"
    assert (
        classify("amber", m(11, swap=96, some=1.5)) == "amber"
    )  # swap's PSI condition has hysteresis too
    assert classify("green", m(16, swap=76)) == "green"
    assert classify("amber", m(20, swap=64)) == "green"
    assert classify("green", m(16, some=5)) == "amber"
    assert classify("green", m(2.9)) == "red" and classify("green", m(5.5, full=21)) == "red"
    # a rebuild burst: PSI high with plenty free is amber at most, never red
    assert (
        classify("green", m(17, full=25)) == "amber" and classify("red", m(17, full=25)) == "amber"
    )
    assert classify("amber", m(9)) == "amber"  # needs 10G to go back to green (~2G hysteresis)
    assert (
        classify("amber", m(10.5, swap=65, some=1)) == "amber"
        and classify("amber", m(10.5, swap=55, some=1)) == "green"
    )
    assert classify("red", m(4)) == "red" and classify("red", m(5.5)) == "amber"


def disk(state, free_g, ballast_g=0):
    return {
        "state": state,
        "path": "/",
        "free_bytes": int(free_g * G),
        "ballast_bytes": int(ballast_g * G),
        "floor_bytes": 30 * G,
        "warn_bytes": 40 * G,
    }


def test_admission_contract_v1():
    doc = memstate.admission("amber", m(6, swap=40, some=6, full=1), 1000.4, "hypervisor-1", LIM)
    assert doc == {
        "v": 1,
        "state": "amber",
        "admit": False,
        "reason": doc["reason"],
        "updated_at": 1000,
        "expires_at": 1030,
        "memory_state": "amber",
        "memory_reason": doc["reason"],
        "mem_available_gib": 6.0,
        "swap_used_pct": 40.0,
        "psi_full_avg10": 1,
        "psi_some_avg60": 6,
        "disk": None,
        "offload": "hypervisor-1",
    }
    assert memstate.admission("green", m(16), 1000, "hypervisor-1", LIM)["offload"] is None


def test_disk_state_lines_and_hysteresis():
    ds = memstate.disk_state
    assert ds("green", 50 * G, 0, LINES, 2) == "green"
    assert ds("green", 39 * G, 0, LINES, 2) == "amber"
    assert ds("green", 35 * G, 6 * G, LINES, 2) == "green"  # the ballast counts as free for amber
    assert ds("green", int(29.9 * G), 6 * G, LINES, 2) == "red"  # ... never for red
    assert ds("red", 31 * G, 0, LINES, 2) == "red" and ds("red", 32 * G, 0, LINES, 2) == "amber"
    assert (
        ds("amber", 41 * G, 0, LINES, 2) == "amber" and ds("amber", 42 * G, 0, LINES, 2) == "green"
    )
    assert (
        ds("green", 9 * G, 0, memstate.Lines(reserve=0, warn=5, crit=2, floor=10), 2) == "red"
    )  # the floor


def test_admission_is_the_worse_of_memory_and_disk():
    red = memstate.admission("green", m(16), 1000, "hypervisor-1", LIM, disk("red", 20))
    assert red["state"] == "red" and red["admit"] is False and red["memory_state"] == "green"
    assert red["reason"] == (
        "Disk is critical: / has 20.0 GiB free, red below 30 (SummitFlow pauses backups there); defer heavy work"
    )
    amber = memstate.admission("green", m(16), 1000, None, LIM, disk("amber", 36, 2))
    assert (
        amber["reason"]
        == "Disk is tight: / has 36.0 GiB free + 2 GiB ballast = 38.0, amber below 40; defer heavy work"
    )
    both = memstate.admission("amber", m(6), 1000, None, LIM, disk("red", 20))
    assert (
        both["state"] == "red"
        and both["reason"].startswith("Disk is critical")
        and "Memory is tight" in both["reason"]
    )
    assert both["reason"].count("defer heavy work") == 1
    tie = memstate.admission("red", m(2), 1000, None, LIM, disk("red", 20))
    assert tie["reason"].startswith("Disk is critical") and "Memory is critical" in tie["reason"]
    unknown = {**disk("green", 0), "state": "unknown", "free_bytes": None}
    assert memstate.disk_reason(unknown) == "Disk unreadable: /"
    assert memstate.admission("green", m(16), 1000, None, LIM, unknown)["admit"] is True


class Statvfs:
    def __init__(self, free_g):
        self.free_g = free_g

    def __call__(self, path):
        if self.free_g is None:
            raise OSError("gone")
        return os.statvfs_result(
            (4096, 4096, 10**9, 0, int(self.free_g * G) // 4096, 0, 0, 0, 0, 255)
        )


class Host:
    """A fixture /proc and /sys: processes, pane scopes, run-*.scope jobs and outside units."""

    def __init__(self, tmp):
        self.tmp, self.proc, self.sys = tmp, tmp / "proc", tmp / "sys"
        self.cg = self.sys / "fs/cgroup"
        self.app = self.cg / f"user.slice/user-{UID}.slice/user@{UID}.service/app.slice"
        (self.proc / "pressure").mkdir(parents=True)
        self.app.mkdir(parents=True)
        self.memory(16)
        self.vmstat(0)
        self.app_events(0, 0)
        self.add(TMUX, 1, "tmux: server", in_unit=None)
        self.add(MANAGER, 1, "systemd", in_unit=None)
        self.journal_lines: list | None = []
        self.unit_results: dict = {}
        self.unit_calls: list = []
        self.unit_read = True

    def memory(self, avail_g):
        (self.proc / "meminfo").write_text(
            f"MemTotal: 32000000 kB\nMemAvailable: {int(avail_g * 2**20)} kB\nSwapTotal: 8000000 kB\nSwapFree: 8000000 kB\n"
        )
        (self.proc / "pressure" / "memory").write_text(
            "some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n"
        )

    def vmstat(self, n):
        (self.proc / "vmstat").write_text(f"nr_free_pages 1\noom_kill {n}\n")

    def app_events(self, oom, kills):
        (self.app / "memory.events").write_text(
            f"low 0\nhigh 0\nmax 0\noom {oom}\noom_kill {kills}\noom_group_kill 0\n"
        )

    def add(
        self,
        pid,
        ppid,
        comm,
        *,
        sid=None,
        pgid=None,
        start=None,
        mb=1,
        swap_mb=0,
        adj=200,
        argv=None,
        in_unit="pane",
    ):
        d = self.proc / str(pid)
        d.mkdir(parents=True, exist_ok=True)
        sid, pgid, start = sid or pid, pgid or pid, start if start is not None else pid
        fields = ["S", ppid, pgid, sid, 0, 0, 0] + [0] * 12 + [start]
        (d / "stat").write_text(f"{pid} ({comm}) " + " ".join(map(str, fields)) + " 0 0\n")
        (d / "comm").write_text(comm + "\n")
        (d / "status").write_text(
            f"Name:\t{comm}\nRssAnon:\t{mb * 1024} kB\nVmSwap:\t{swap_mb * 1024} kB\n"
        )
        (d / "oom_score_adj").write_text(str(adj))
        (d / "cmdline").write_bytes(("\0".join(argv or [comm]) + "\0").encode())
        return pid

    def unit(self, name, pids, *, base=None, oom=0, kills=0, anon=None, swap=0):
        d = (base or self.app) / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "cgroup.procs").write_text("".join(f"{p}\n" for p in pids))
        (d / "memory.events").write_text(
            f"low 0\nhigh 0\nmax 0\noom {oom}\noom_kill {kills}\noom_group_kill 0\n"
        )
        (d / "memory.current").write_text(str(anon or 0))
        (d / "memory.stat").write_text(f"anon {anon or 0}\nfile 0\n")
        (d / "memory.swap.current").write_text(str(swap))
        return name

    def claude_pane(self, root, *, agent_mb=400):
        """root bash (session leader, child of tmux) -> claude, both in the root's process group."""
        self.add(root, TMUX, "bash", argv=["/bin/bash", "--noprofile", "--norc", "-c", "claude"])
        self.add(
            root + 1,
            root,
            "claude",
            sid=root,
            pgid=root,
            mb=agent_mb,
            argv=["/home/u/.local/bin/claude", "--add-dir", "/x"],
        )
        return [root, root + 1]

    def run(self, argv, timeout=60, input_text=None):
        """journalctl: the kernel journal (-k) or the user manager's unit results (--user)."""
        if "-k" in argv:
            if self.journal_lines is None:
                return Result(1, "", "journal unreadable")
            return Result(
                0,
                "\n".join(
                    json.dumps({"MESSAGE": msg, "__REALTIME_TIMESTAMP": str(int(ts * 1e6))})
                    for ts, msg in self.journal_lines
                ),
            )
        unit = next(a for a in argv if a.startswith("USER_UNIT=")).split("=", 1)[1]
        self.unit_calls.append((unit, argv[argv.index("--since") + 1]))
        if not self.unit_read:
            return Result(1, "", "journal unreadable")
        result = self.unit_results.get(unit)
        return Result(0, json.dumps({"USER_UNIT": unit, "UNIT_RESULT": result}) if result else "")

    def controller(self, **kw):
        kw.setdefault("events", self.tmp / "state/memory-events.jsonl")
        kw.setdefault("heartbeat", self.tmp / "run/memctl.json")
        kw.setdefault("now", 0)
        kw.setdefault("run", self.run)
        return memctl.Controller(
            UID, self.tmp / "run/admission.json", LIM, TUNE, AGENTS, self.proc, self.sys, **kw
        )

    def events(self):
        return memevents.read(self.tmp / "state/memory-events.jsonl")


def red_ticks(host, ctl, n=2, t0=100):
    host.memory(2)
    return [ctl.tick(t0 + 10 * i) for i in range(n)]


def kernel_kill(ts, pid, comm="python", scope="tmux-spawn-a.scope", kb=1_500_000):
    memcg = f"/user.slice/user-{UID}.slice/user@{UID}.service/app.slice/{scope}"
    return [
        (
            ts,
            (
                f"oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=user.slice,mems_allowed=0,oom_memcg={memcg},"
                f"task_memcg={memcg},task={comm},pid={pid},uid={UID}"
            ),
        ),
        (
            ts,
            (
                f"Memory cgroup out of memory: Killed process {pid} ({comm}) total-vm:1kB, anon-rss:{kb}kB, file-rss:0kB, "
                f"shmem-rss:0kB, UID:{UID} pgtables:1kB oom_score_adj:200"
            ),
        ),
    ]


def test_memctl_never_acts_in_the_panes(tmp_path):
    """Agent tool jobs are Tether's (its memory guard): on amber and red memctl closes admission and touches no process."""
    h = Host(tmp_path)
    pane = h.claude_pane(1000, agent_mb=5000)
    tool = h.add(2000, 1001, "bash", sid=2000, pgid=2000, mb=4, adj=100)
    big = h.add(2001, 2000, "python", sid=2000, pgid=2001, mb=3000)
    h.unit("tmux-spawn-a.scope", [*pane, tool, big], anon=8 * G)
    ctl = h.controller()
    ctl.tick(0)
    h.memory(6)
    assert ctl.tick(10)["state"] == "amber"
    docs = red_ticks(h, ctl, 4, t0=20)
    assert docs[-1]["state"] == "red" and docs[-1]["admit"] is False and docs[-1]["throttled"] == []
    assert "Tether may kill the largest agent tool job" in docs[-1]["reason"]
    assert h.events() == []
    assert (h.proc / "2000/oom_score_adj").read_text() == "100"
    hb = json.loads((tmp_path / "run/memctl.json").read_text())
    assert hb["state"] == "red" and hb["red_since"] == 20
    assert not hasattr(memctl, "pidfd_kill")


def test_codex_agent_chain_is_the_agent_and_codex_exec_a_tool(tmp_path):
    h = Host(tmp_path)
    h.add(1000, TMUX, "bash")
    h.add(
        1001,
        1000,
        "MainThread",
        sid=1000,
        pgid=1000,
        mb=300,
        argv=["node", "/home/u/.local/bin/codex-real", "-c", "x"],
    )
    h.add(1002, 1001, "codex", sid=1000, pgid=1000, mb=900, argv=["/opt/codex/codex"])
    h.add(
        3000,
        1002,
        "bash",
        sid=1000,
        pgid=3000,
        mb=4,
        argv=["/bin/bash", "-lc", "codex exec imagegen"],
    )
    h.add(3001, 3000, "codex", sid=1000, pgid=3000, mb=1500, argv=["codex", "exec", "imagegen"])
    h.add(3100, 1002, "fallow-mcp", sid=1000, pgid=3100, mb=50)
    h.unit("tmux-spawn-c.scope", [1000, 1001, 1002, 3000, 3001, 3100])
    found, runs = h.controller().snapshot()
    pane = found["tmux-spawn-c.scope"]
    assert pane.root == 1000 and pane.agents == {1001, 1002}
    jobs, _ = panes.build_jobs(found, runs)
    assert [(j.key, sorted(p.pid for p in j.members)) for j in jobs] == [
        (("tree", 3000), [3000, 3001]),
        (("tree", 3100), [3100]),
    ]


def test_reparented_job_and_run_scope_job_from_a_pane_belong_to_the_pane(tmp_path):
    h = Host(tmp_path)
    pane = h.claude_pane(1000)
    orphan = h.add(4000, MANAGER, "node", sid=4000, mb=1200)
    tool = h.add(5000, 1001, "bash", sid=5000, mb=4)
    h.unit("tmux-spawn-a.scope", [*pane, orphan, tool])
    h.add(5001, 5000, "godot", sid=5000, mb=1800)
    h.unit("run-r1.scope", [5001])
    found, runs = h.controller().snapshot()
    jobs, outside = panes.build_jobs(found, runs)
    assert outside == []
    assert {j.key: sorted(p.pid for p in j.members) for j in jobs} == {
        ("sid", 4000): [4000],
        ("sid", 5000): [5000, 5001],
    }


def test_outside_hog_is_recorded_not_killed(tmp_path):
    h = Host(tmp_path)
    h.unit("tmux-spawn-a.scope", h.claude_pane(1000))
    h.add(7000, MANAGER, "python", mb=3000)
    h.unit("run-r9.scope", [7000])
    h.unit("docker-shadow.service", [], base=h.cg / "system.slice", anon=6 * G, swap=G)
    ctl = h.controller()
    red_ticks(h, ctl, 12)  # 110 s of critical memory: not yet
    assert not [r for r in h.events() if r["kind"] == "outside-hog"]
    ctl.tick(220)
    hog = [r for r in h.events() if r["kind"] == "outside-hog"]
    assert len(hog) == 1 and hog[0]["scope"] == "docker-shadow.service" and hog[0]["bytes"] == 7 * G
    assert hog[0]["top"][0] == ["docker-shadow.service", 7 * G] and len(hog[0]["top"]) <= 4


def test_outside_hog_waits_while_tethers_guard_has_a_job_to_stop(tmp_path):
    h = Host(tmp_path)
    h.unit("tmux-spawn-a.scope", h.claude_pane(1000))
    h.unit("docker-shadow.service", [], base=h.cg / "system.slice", anon=6 * G)
    guard = tmp_path / "run/tether/default/memory-guard.json"
    guard.parent.mkdir(parents=True)
    ctl = h.controller(tether=memctl.Tether(tmp_path, guard.parent))
    guard.write_text(json.dumps({"v": 1, "ts": 220, "kill_candidate": True}))
    red_ticks(h, ctl, 13)
    assert not [r for r in h.events() if r["kind"] == "outside-hog"]
    guard.write_text(
        json.dumps({"v": 1, "ts": 150, "kill_candidate": True})
    )  # stale: Tether is not acting
    ctl.tick(230)
    assert [r["scope"] for r in h.events() if r["kind"] == "outside-hog"] == [
        "docker-shadow.service"
    ]


def test_kernel_kill_recorded_from_journal_with_tether_session(tmp_path):
    h = Host(tmp_path)
    pane = h.claude_pane(1000)
    tool = h.add(2000, 1001, "python", sid=2000, mb=300, argv=["python", "train.py"])
    h.unit("tmux-spawn-a.scope", [*pane, tool])
    db = tmp_path / "tether.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE sessions (id TEXT, scope_unit TEXT)")
    con.execute("INSERT INTO sessions VALUES ('0ae3a04f', 'tmux-spawn-a.scope')")
    con.commit()
    con.close()
    ctl = h.controller(tether=memctl.Tether(db.parent, tmp_path / "run/tether"))
    ctl.tick(100)
    h.unit("tmux-spawn-a.scope", pane, oom=1, kills=1)
    h.app_events(0, 1)
    h.vmstat(1)
    ctl.tick(110)
    assert [
        r for r in h.events() if r["kind"] == "kill"
    ] == []  # the journal is read one tick later
    h.journal_lines = kernel_kill(105.0, 2000, kb=300000)
    ctl.tick(120)
    ctl.tick(130)
    kills = [r for r in h.events() if r["kind"] == "kill"]
    assert len(kills) == 1
    k = kills[0]
    assert (k["killer"], k["scope"], k["pid"], k["comm"], k["bytes"], k["class"]) == (
        "kernel-pane-cap",
        "tmux-spawn-a.scope",
        2000,
        "python",
        300000 * 1024,
        "tool",
    )
    assert (
        k["tether_session_id"] == "0ae3a04f"
        and k["cmdline_head"] == "python train.py"
        and k["starttime"] == 2000
    )
    assert k["ts"] == 105.0 and k["host_state"] == "green"


def _counter_only_then_gone(tmp_path):
    """A pane kill counted while the journal fails; the pane goes 10 s later (its unit ends with Result=success under
    OOMPolicy=continue), so only the kill's own line can say what it took."""
    h = Host(tmp_path)
    pane = h.claude_pane(1000)
    h.unit("tmux-spawn-a.scope", pane)
    h.journal_lines = None
    ctl = h.controller()
    ctl.tick(100)
    h.unit("tmux-spawn-a.scope", pane, kills=1)
    h.app_events(0, 1)
    h.vmstat(1)
    ctl.tick(110)
    shutil.rmtree(h.app / "tmux-spawn-a.scope")
    ctl.tick(120)
    ctl.tick(130)
    assert h.events() == []
    ctl.tick(140)
    assert [(r["kind"], r["killer"], r["scope"], r.get("source")) for r in h.events()] == [
        ("kill", "kernel-global", "tmux-spawn-a.scope", "counter")
    ]
    return h, ctl


def test_counter_only_pane_kill_waits_for_its_journal_line_and_the_root_shell_loss_is_told(
    tmp_path,
):
    h, ctl = _counter_only_then_gone(tmp_path)
    for t in range(150, 300, 10):
        ctl.tick(t)
    assert [r["kind"] for r in h.events()] == ["kill"]
    h.journal_lines = kernel_kill(
        105.0, 1000, "bash"
    )  # the journal reads again: the kernel took the pane's root shell
    ctl.tick(300)
    late, stop = h.events()[1:]
    assert (late["kind"], late["pid"], late["class"], late["late"], late["ts"]) == (
        "kill",
        1000,
        "container",
        True,
        105.0,
    )
    assert (stop["kind"], stop["lost"], stop["agent"], stop.get("unit_result")) == (
        "pane-stopped",
        "root",
        "claude",
        None,
    )
    for t in range(310, 400, 10):
        ctl.tick(t)
    assert len(h.events()) == 3  # once


def test_counter_only_pane_kill_with_no_line_is_no_pane_stopped(tmp_path):
    h, ctl = _counter_only_then_gone(tmp_path)
    for t in range(150, 150 + int(TUNE.result_give_up_s) + 100, 10):
        ctl.tick(t)
    assert [r["kind"] for r in h.events()] == ["kill"] and ctl.late == [] and ctl.stop_wait == set()


def test_two_kernel_kills_on_consecutive_ticks_are_two_records(tmp_path):
    """A kill counted while the previous one is resolved: its journal line is already in that read and is recorded
    once, not again from its counter."""
    h = Host(tmp_path)
    pane = h.claude_pane(1000)
    h.unit("tmux-spawn-a.scope", pane)
    ctl = h.controller()
    ctl.tick(0)
    h.unit("tmux-spawn-a.scope", pane, oom=1, kills=1)
    h.app_events(1, 1)
    h.vmstat(1)
    ctl.tick(10)
    h.journal_lines = kernel_kill(9.0, 5001) + kernel_kill(15.0, 5002)
    h.unit("tmux-spawn-a.scope", pane, oom=2, kills=2)
    h.app_events(2, 2)
    h.vmstat(2)
    ctl.tick(20)
    for t in (30, 40, 50, 60, 70):
        ctl.tick(t)
    assert [(r["pid"], r.get("source")) for r in h.events() if r["kind"] == "kill"] == [
        (5001, None),
        (5002, None),
    ]


def _pane_gone_after_kill(tmp_path, result, read=True, victim=5001, comm="python"):
    h = Host(tmp_path)
    pane = h.claude_pane(1000)
    h.unit("tmux-spawn-a.scope", pane)
    h.unit_results["tmux-spawn-a.scope"] = result
    h.unit_read = read
    ctl = h.controller()
    ctl.tick(0)
    h.unit("tmux-spawn-a.scope", pane, oom=1, kills=1)
    h.app_events(1, 1)
    h.vmstat(1)
    h.journal_lines = kernel_kill(9.0, victim, comm)
    ctl.tick(10)  # the kill is recorded; the pane is still there
    shutil.rmtree(h.app / "tmux-spawn-a.scope")  # 38 s later the pane goes
    for t in range(48, 48 + 10 * 40, 10):
        ctl.tick(t)
    return h


def test_pane_that_ends_cleanly_after_a_tool_kill_gets_no_pane_stopped_record(tmp_path):
    h = _pane_gone_after_kill(tmp_path, None)
    assert [r["kind"] for r in h.events()] == ["kill"]
    assert h.unit_calls and h.unit_calls[0][0] == "tmux-spawn-a.scope"
    assert (
        len(h.unit_calls) <= TUNE.result_grace_s / TUNE.tick_s + 1
    )  # asked until the grace ran out


def test_pane_killed_by_its_cap_gets_one_pane_stopped_record_with_its_result(tmp_path):
    h = _pane_gone_after_kill(tmp_path, "oom-kill")
    stops = [r for r in h.events() if r["kind"] == "pane-stopped"]
    assert [(r["scope"], r["ts"], r["unit_result"], r["agent"]) for r in stops] == [
        ("tmux-spawn-a.scope", 9.0, "oom-kill", "claude")
    ]
    assert len(h.unit_calls) == 1


def test_pane_whose_root_shell_or_agent_the_kernel_killed_is_stopped_without_a_unit_result(
    tmp_path,
):
    for victim, comm, lost in ((1000, "bash", "root"), (1001, "claude", "agent")):
        h = _pane_gone_after_kill(tmp_path / comm, None, victim=victim, comm=comm)
        stops = [r for r in h.events() if r["kind"] == "pane-stopped"]
        assert [(r["scope"], r["lost"], r["agent"], r.get("unit_result")) for r in stops] == [
            ("tmux-spawn-a.scope", lost, "claude", None)
        ]
        assert h.unit_calls == []  # the kill proves it: no journal read


def test_pane_result_other_than_a_failure_or_an_unreadable_journal_is_no_record(tmp_path):
    assert [r["kind"] for r in _pane_gone_after_kill(tmp_path, "timeout").events()] == ["kill"]
    h = _pane_gone_after_kill(tmp_path / "x", "oom-kill", read=False)
    assert [r["kind"] for r in h.events()] == [
        "kill"
    ]  # no proof, no record, even after result_give_up_s
    assert (
        len(h.unit_calls) > TUNE.result_grace_s / TUNE.tick_s + 1
    )  # kept asking while the journal failed


def test_pane_result_is_not_asked_while_memory_is_red(tmp_path):
    h = Host(tmp_path)
    pane = h.claude_pane(1000)
    h.unit("tmux-spawn-a.scope", pane)
    h.unit_results["tmux-spawn-a.scope"] = "oom-kill"
    ctl = h.controller()
    ctl.tick(0)
    h.unit("tmux-spawn-a.scope", pane, oom=1, kills=1)
    h.app_events(1, 1)
    h.vmstat(1)
    h.journal_lines = kernel_kill(9.0, 5001)
    ctl.tick(10)
    shutil.rmtree(h.app / "tmux-spawn-a.scope")
    h.memory(2)
    ctl.tick(20)
    ctl.tick(30)
    assert h.unit_calls == []
    h.memory(16)
    for t in (40, 50, 60):  # back to green (via amber): asked then
        ctl.tick(t)
    assert h.unit_calls and [r["kind"] for r in h.events()] == ["kill", "pane-stopped"]


def test_red_disk_closes_admission_and_memory_stays_green(tmp_path):
    h = Host(tmp_path)
    ctl = h.controller(
        disks=["/"], disk_lines=lambda: (LINES, {"/": 6 * G}, 2.0), statvfs=Statvfs(20)
    )
    doc = ctl.tick(0)
    assert (doc["state"], doc["memory_state"], doc["admit"]) == ("red", "green", False)
    assert doc["disk"]["ballast_bytes"] == 6 * G
    ctl.statvfs = Statvfs(None)  # unreadable: state unknown, memory's verdict stands
    assert ctl.tick(10)["state"] == "green"
    assert memctl.build is not None


def test_memctl_is_dry_until_acting_is_on(tmp_path):
    """Off: the admission, heartbeat and event record go to host-steward's own files and nothing is shared; on: the
    live paths Tether and SummitFlow read, and the shared copy."""
    data = copy.deepcopy(DATA)
    data["memctl"]["paths"]["shared_dir"] = str(tmp_path / "shared")
    (tmp_path / "shared").mkdir()
    dry = memctl.build(data, False, UID, str(tmp_path / "home"), str(tmp_path / "run"))
    assert dry.out == tmp_path / "run/host-steward/admission.json"
    assert dry.heartbeat == tmp_path / "run/host-steward/memctl.json"
    assert dry.events == tmp_path / "home/.local/state/host-steward/memory-events.jsonl"
    assert dry.share is None
    live = memctl.build(data, True, UID, str(tmp_path / "home"), str(tmp_path / "run"))
    assert live.out == tmp_path / "run/nightshift/admission.json"
    assert live.heartbeat == tmp_path / "run/nightshift/memctl.json"
    assert live.events == tmp_path / "home/.local/state/nightshift/memory-events.jsonl"
    assert live.share == tmp_path / "shared"


def test_status_row_says_dry_run_and_what_it_would_have_done(tmp_path):
    h = Host(tmp_path)
    ctl = h.controller()
    doc = ctl.tick(0)
    row = memctl.status_row(ctl, doc, False, "box", 100.0)
    assert row["id"] == "box/service-memctl" and row["kind"] == "service" and row["state"] == "ok"
    assert (
        row["meaning"].startswith("Dry run: memory green")
        and 'Would publish admission "green" (admit)' in row["meaning"]
    )
    on = memctl.status_row(ctl, doc, True, "box", 100.0)
    assert on["meaning"].startswith("Running: memory green") and "Dry run" not in on["meaning"]


def test_main_once_dry_writes_only_its_own_files(tmp_path, monkeypatch):
    h = Host(tmp_path)
    data = copy.deepcopy(DATA)
    data["checks"]["storage"]["disks"] = []
    data["acting"]["memctl"] = False
    monkeypatch.setattr(memctl, "build", lambda *a: h.controller(now=0))
    posted = []
    code = memctl.main(Namespace(once=True, preview=False), data, posted.append)
    assert code == 0 and len(posted) == 1 and posted[0]["meaning"].startswith("Dry run")
    assert (tmp_path / "run/admission.json").exists()


def test_offload_and_ballast_readers(tmp_path):
    state = tmp_path / "state.json"
    state.write_text(
        json.dumps({"checks": {"pve": {"offload": {"host": "pve-1", "mem_available_gib": 25.4}}}})
    )
    assert memctl.read_offload(state, 8 * G) == "pve-1"
    state.write_text(
        json.dumps({"checks": {"pve": {"offload": {"host": "pve-1", "mem_available_gib": 2}}}})
    )
    assert memctl.read_offload(state, 8 * G) is None
    assert memctl.read_offload(tmp_path / "missing.json", 8 * G) is None
    guard = tmp_path / "space-guard.json"
    guard.write_text(json.dumps({"ballast": {"/": 6442450944}}))
    assert memctl.read_ballast(guard) == {"/": 6442450944}
    assert memctl.read_ballast(tmp_path / "missing.json") == {}


def test_memevents_record_append_rotate_read(tmp_path):
    path = tmp_path / "state/events.jsonl"
    memevents.append(
        path, memevents.record("kill", 1.0, killer="kernel-global", scope="x.scope"), max_bytes=100
    )
    memevents.append(path, memevents.record("warning", 2.0), max_bytes=100)
    assert [r["kind"] for r in memevents.read(path)] == ["kill", "warning"]
    assert path.with_name("events.jsonl.1").exists()
    assert [r["ts"] for r in memevents.read(path, since=1.5)] == [2.0]
    with pytest.raises(ValueError):
        memevents.record("nonsense", 1.0)
    with pytest.raises(ValueError):
        memevents.record("kill", 1.0, killer="someone")


def test_parse_kernel_global_oom_and_unit_of():
    assert (
        memevents.unit_of(
            "/user.slice/user-1.slice/user@1.service/app.slice/tmux-spawn-a.scope/sub"
        )
        == "tmux-spawn-a.scope"
    )  # a sub-cgroup is still the pane
    assert (
        memevents.unit_of("/user.slice/user-1.slice/user@1.service/app.slice/tmux-spawn-a.scope")
        == "tmux-spawn-a.scope"
    )
    line = (
        1.0,
        "oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),oom_memcg=/,task_memcg=/system.slice/x.service,task=java,pid=9,uid=0",
    )
    kill = memevents.parse_kernel([line])[0]
    assert (kill["killer"], kill["scope"], kill["comm"]) == ("kernel-global", "x.service", "java")


# --- the memory check -------------------------------------------------------------------------------------------

NOW = 1_800_000_000.0
PANE = "tmux-spawn-71d4e32a-ad33-45cf-be4f-4e322d0f382a.scope"


class CheckHost:
    def __init__(self, tmp):
        self.tmp = tmp
        self.cfg = {
            **DATA["checks"]["memory"],
            "meminfo": str(tmp / "meminfo"),
            "psi_memory": str(tmp / "psi"),
            "cgroup_user": str(tmp / "cg/user"),
            "cgroup_system": str(tmp / "cg/system"),
            "home": str(tmp / "home"),
            "memctl": {
                who: {**ctl, "heartbeat": str(tmp / "hb.json"), "admission": str(tmp / "adm.json")}
                for who, ctl in DATA["checks"]["memory"]["memctl"].items()
            },
            "guard": str(tmp / "guard.json"),
            "events": str(tmp / "events.jsonl"),
            "recoveries": str(tmp / "recoveries.json"),
        }
        (tmp / "meminfo").write_text("MemTotal: 32000000 kB\nMemAvailable: 22000000 kB\n")
        self.psi(0, 0)
        (tmp / "cg/user/app.slice/a.service").mkdir(parents=True)
        (tmp / "cg/system").mkdir(parents=True)
        self.cg("a.service", 0)
        self.fresh()
        self.kern, self.units, self.daemons = Result(0, ""), Result(0, ""), Result(1, "")

    def psi(self, some_us, full_us):
        (self.tmp / "psi").write_text(
            f"some avg10=0 avg60=0 avg300=0 total={some_us}\nfull avg10=0 avg60=0 avg300=0 total={full_us}\n"
        )

    def cg(self, name, some_us):
        (self.tmp / "cg/user/app.slice" / name / "memory.pressure").write_text(
            f"some avg10=0 avg60=0 avg300=0 total={some_us}\nfull avg10=0 avg60=0 avg300=0 total=0\n"
        )

    def fresh(self, at=NOW - 5, state="green"):
        (self.tmp / "hb.json").write_text(json.dumps({"ts": at, "state": state}))
        (self.tmp / "guard.json").write_text(json.dumps({"ts": at}))

    def run(self, argv, timeout=60, input_text=None):
        if "-k" in argv:
            return self.kern
        if "SYSLOG_IDENTIFIER=tether" in argv:
            return self.daemons
        return self.units

    def ctx(self, state, now=NOW, acting=None):
        return core.Ctx(
            cfg=self.cfg, site=DATA["site"], now=now, run=self.run, state=state, acting=acting or {}
        )


def codes(signals):
    return {s.code: s.state for s in signals}


def test_stall_delta_baselines_then_rates_the_share_of_wall_time(tmp_path):
    h = CheckHost(tmp_path)
    state: dict = {}
    first = memory.stall(h.ctx(state))
    assert (first.code, first.state, first.fields["baseline"]) == ("memory.stall", "ok", True)
    h.psi(60_000_000, 30_000_000)  # 60 s of "some" and 30 s of "full" over 900 s
    h.cg("a.service", 45_000_000)
    calm = memory.stall(h.ctx(state, NOW + 900))
    # full 3.3% of wall time is over the line: warn, naming the most stalled unit
    assert calm.state == "warn" and calm.fields["top"] == "a 45s" and calm.fields["min"] == "15"
    assert calm.fields["some"] == "6.7" and calm.fields["full"] == "3.3"
    h.psi(61_000_000, 30_100_000)
    again = memory.stall(h.ctx(state, NOW + 1800))
    assert again.state == "ok"
    h.psi(0, 0)  # counters reset (reboot): a new baseline
    assert memory.stall(h.ctx(state, NOW + 2700)).fields.get("baseline") is True


def test_stall_not_readable_warns(tmp_path):
    h = CheckHost(tmp_path)
    h.cfg["psi_memory"] = str(tmp_path / "missing")
    sig = memory.stall(h.ctx({}))
    assert (sig.code, sig.state) == ("memory.stall.unreadable", "warn")


def test_controllers_report_or_go_stale(tmp_path):
    h = CheckHost(tmp_path)
    assert codes(memory.controllers(h.ctx({}))) == {
        "memory.memctl_alive": "ok",
        "memory.guard_alive": "ok",
    }
    h.fresh(at=NOW - 600)
    got = memory.controllers(h.ctx({}))
    assert codes(got) == {"memory.memctl_alive": "warn", "memory.guard_alive": "warn"}
    assert got[0].fields["ago"] == "last reported 10 min ago"
    (tmp_path / "hb.json").unlink()
    (tmp_path / "adm.json").write_text(
        json.dumps({"updated_at": NOW - 3, "state": "amber"})
    )  # older memctl: admission only
    assert memory.controllers(h.ctx({}))[0].state == "ok"
    (tmp_path / "adm.json").unlink()
    assert memory.controllers(h.ctx({}))[0].fields["ago"] == "has not reported since boot"


def test_memctl_alive_reads_and_names_the_acting_controller(tmp_path):
    """[acting] memctl off: Nightshift's memctl is the one that must report (and the one to restart); on:
    host-steward's, read at its own configured heartbeat."""
    h = CheckHost(tmp_path)
    h.cfg["memctl"]["host-steward"]["heartbeat"] = str(tmp_path / "hs-hb.json")
    h.cfg["memctl"]["host-steward"]["admission"] = str(tmp_path / "hs-adm.json")
    h.fresh(at=NOW - 600)  # Nightshift's heartbeat is stale
    (tmp_path / "hs-hb.json").write_text(json.dumps({"ts": NOW - 5, "state": "green"}))
    off = memory.controllers(h.ctx({}))[0]
    assert (off.state, off.fields["name"], off.fields["unit"]) == (
        "warn",
        "Nightshift",
        "nightshift-memctl",
    )
    text = core.explain(off.code, off.fields, DATA["meanings"], True, off.state)
    assert text.startswith("Nightshift's memory controller last reported 10 min ago")
    assert "systemctl --user restart nightshift-memctl" in text
    on = memory.controllers(h.ctx({}, acting={"memctl": True}))[0]
    assert (on.state, on.fields["name"]) == ("ok", "host-steward")
    (tmp_path / "hs-hb.json").unlink()
    gone = memory.controllers(h.ctx({}, acting={"memctl": True}))[0]
    assert "systemctl --user restart host-steward-memctl" in core.explain(
        gone.code, gone.fields, DATA["meanings"], True, gone.state
    )


def journal_line(ts, message, **extra):
    return json.dumps({"MESSAGE": message, "__REALTIME_TIMESTAMP": str(int(ts * 1e6)), **extra})


def test_kills_none_then_a_tool_kill_is_a_note_and_a_lost_pane_warns(tmp_path):
    h = CheckHost(tmp_path)
    (tmp_path / "events.jsonl").write_text("")
    sig = memory.kills(h.ctx({}))
    assert [(s.code, s.state, s.note) for s in sig] == [("memory.kills", "ok", False)]
    # a tool killed in a pane: a note, the agent is told, not the owner
    memevents.append(
        tmp_path / "events.jsonl",
        memevents.record(
            "kill",
            NOW - 3600,
            killer="kernel-pane-cap",
            scope=PANE,
            pid=5,
            comm="python",
            bytes=2 * G,
            **{"class": "tool"},
        ),
    )
    sig = memory.kills(h.ctx({}))[0]
    assert (sig.state, sig.note, sig.fields["n"]) == (
        "ok",
        True,
        1,
    ) and "python (2.0 GiB) killed" in sig.fields["list"]
    # the pane's root shell is killed and its unit failed: pane-stopped, warn
    memevents.append(
        tmp_path / "events.jsonl",
        memevents.record(
            "kill",
            NOW - 7200,
            killer="kernel-pane-cap",
            scope=PANE,
            pid=6,
            comm="bash",
            bytes=G,
            **{"class": "container"},
        ),
    )
    memevents.append(
        tmp_path / "events.jsonl",
        memevents.record(
            "pane-stopped",
            NOW - 7200,
            killer="kernel-pane-cap",
            scope=PANE,
            lost="root",
            agent="claude",
            **{"class": "container"},
        ),
    )
    sig = memory.kills(h.ctx({}))[0]
    assert sig.state == "warn" and "closed by an OOM kill" in sig.fields["list"]


def test_kills_reads_the_kernel_journal_when_memctl_was_down(tmp_path):
    h = CheckHost(tmp_path)
    memcg = f"/user.slice/user-1000.slice/user@1000.service/app.slice/{PANE}"
    h.kern = Result(
        0,
        "\n".join(
            [
                journal_line(
                    NOW - 100,
                    f"oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),oom_memcg={memcg},task_memcg={memcg},task=claude,pid=77,uid=1000",
                ),
                journal_line(
                    NOW - 100,
                    "Memory cgroup out of memory: Killed process 77 (claude) total-vm:1kB, anon-rss:900000kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:1kB oom_score_adj:200",
                ),
            ]
        ),
    )
    out = memory.kills(h.ctx({}))
    kill = out[0]
    assert kill.state == "warn" and "agent killed" in kill.fields["list"]
    # no memctl record exists: said, not a problem
    assert [s.code for s in out] == ["memory.kills", "memory.kills.unread"] and out[1].note


def test_kills_ignores_test_panes_and_unread_journal_is_said(tmp_path):
    h = CheckHost(tmp_path)
    memevents.append(
        tmp_path / "events.jsonl",
        memevents.record(
            "kill",
            NOW - 60,
            killer="kernel-pane-cap",
            scope="tmux-spawn-zzv-v5.scope",
            pid=5,
            comm="python",
            **{"class": "agent"},
        ),
    )
    h.kern = Result(1, "", "boom")
    out = memory.kills(h.ctx({}))
    assert out[0].state == "ok" and out[0].fields["n"] == 0
    assert out[1].code == "memory.kills.unread" and "kernel journal" in out[1].fields["unread"]


def test_incidents_tether_recovery_takes_the_push_off_and_a_loop_is_found(tmp_path):
    kills = [
        {
            "ts": NOW - 3000 + i * 300,
            "pid": 10 + i,
            "comm": "python",
            "bytes": G,
            "scope": PANE,
            "killer": "kernel-pane-cap",
        }
        for i in range(3)
    ]
    kw = {"window_s": 86400, "match_s": 180, "loop_n": 3, "loop_s": 3600, "tether_grace_s": 300}
    incs = memalerts.incidents([], kills, [], [], NOW, set(), **kw)
    assert sorted(i["class"] for i in incs) == ["kill-loop", "tool-kill", "tool-kill", "tool-kill"]
    assert next(i for i in incs if i["class"] == "kill-loop")["count"] == 3
    assert (
        memalerts.incidents([], kills, [], [], NOW, {PANE}, **kw) == []
    )  # a test pane is never an incident
    stops = [{"ts": NOW - 1000, "unit": PANE, "result": "oom-kill"}]
    held = [
        {
            "id": "0ae3a04f",
            "name": "Build",
            "state": "recovered",
            "kind": "",
            "cause": "oom-kill",
            "signal": None,
            "agent_was_hog": False,
            "victim": None,
            "died_at": NOW - 1000,
            "recovered_at": NOW - 900,
            "attempt": 1,
            "reason": None,
            "scope": PANE,
        }
    ]
    got = memalerts.incidents([], [], stops, held, NOW, set(), **kw)
    stopped = next(i for i in got if i["class"] == "pane-stopped")
    assert (
        stopped["push"] is False
        and stopped["why_not"] == "Tether: recovered"
        and stopped["name"] == "Build"
    )
    assert memalerts.line(stopped) == "Build: closed by an OOM kill"


def test_memory_check_makes_one_row(tmp_path):
    h = CheckHost(tmp_path)
    (tmp_path / "events.jsonl").write_text("")
    row = core.make_row(
        "memory", memory.run(h.ctx({})), h.cfg, DATA["meanings"], "box", NOW, DATA["caps"]
    )
    assert row["id"] == "box/check-memory" and row["state"] == "ok"
    assert row["meaning"] == DATA["meanings"]["ok"]["memory"]
    h.fresh(at=NOW - 600)
    bad = core.make_row(
        "memory", memory.run(h.ctx({})), h.cfg, DATA["meanings"], "box", NOW, DATA["caps"]
    )
    assert bad["state"] == "warn" and bad["meaning"].startswith(
        "Nightshift's memory controller last reported 10 min ago"
    )
