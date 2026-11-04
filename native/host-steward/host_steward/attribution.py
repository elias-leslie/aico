"""Who caused a change on this host, read from the kernel when a check sees it (root checks).

Port of ns/attribution.py. A process is ours when its ancestry holds an agent process (Claude Code or Codex; its Aico
session from that process's AICO_WIDGET_ID), or its cgroup is a service the site table names exactly
([site.trusted_units] in checks.toml: this install's own units and SummitFlow-managed project services, system or user
scope as listed). A listed unit must be a persistent unit with its unit file in place, never a transient one
(`systemd-run --unit=<listed name>`), except the exact sf-rebuild-<project>.service names: SummitFlow's managed
rebuild runs as a transient user unit by design. No name prefix and no working directory makes a process ours.
Anything else is None: the change is not ours as far as the check can tell.

Agents run as the owner's user, so this is attribution, not authentication: a process of that user can fake an agent's
ancestry. The tool names, environment variable names and the label wording are data ([site.attribution]). Stdlib only.
The session title swap Nightshift did on the user side is not ported: the label carries the session id.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

PROC = Path("/proc")
CGROUP_ROOT = Path("/sys/fs/cgroup")
WIDGET = re.compile(r"[0-9a-f]{4,64}")
PROJECT = re.compile(r"[a-z0-9][a-z0-9_-]{0,47}")
UNIT = re.compile(r"[\w@.:-]{1,120}\.(service|scope)")
MAX_DEPTH = 64
SYSTEM_UNIT_DIRS = ("etc/systemd/system", "usr/lib/systemd/system", "lib/systemd/system")
USER_UNIT_DIRS = ("etc/systemd/user", "usr/lib/systemd/user")


def trusted_project(units: dict[str, dict[str, str]], unit: str, scope: str) -> str:
    """The project of a trusted unit name in this scope (site `trusted_units`; a "name@.service" entry covers that
    template's instances), or ""."""
    table = units.get(scope) or {}
    head, at, rest = unit.partition("@")
    if at and rest == ".service":  # a template is never a running unit
        return ""
    return table.get(unit) or (table.get(f"{head}@.service", "") if at else "")


class Owner:
    """The site owner's uid and home: only their processes and cgroups (and system units) can be ours. units: the
    site's trusted units ({"system" | "user": {unit: project}}); root: where unit files are looked up (tests)."""

    def __init__(
        self,
        uid: int,
        home: str,
        units: dict[str, dict[str, str]] | None = None,
        root: str = "/",
        settings: dict[str, Any] | None = None,
    ) -> None:
        self.uid, self.home, self.root = uid, home.rstrip("/"), root.rstrip("/") or ""
        self.units = units if units is not None else {"system": {}, "user": {}}
        cfg = settings or {}
        self.tools: dict[str, str] = dict(cfg.get("tools") or {})
        self.own_projects: dict[str, str] = dict(cfg.get("own_projects") or {})
        self.env_widget = str(cfg.get("env_widget") or "AICO_WIDGET_ID")
        self.env_project = str(cfg.get("env_project") or "AICO_PROJECT_ID")
        self.label_widget = str(cfg.get("label_widget") or "Agent in session {widget}")
        self.label_outside = str(cfg.get("label_outside") or "{tool} session outside Aico")

    def cgroup_ok(self, cg: str) -> bool:
        return cg.startswith(
            ("/system.slice/", f"/user.slice/user-{self.uid}.slice/user@{self.uid}.service/")
        )

    def scope(self, cg: str) -> str:
        return "system" if cg.startswith("/system.slice/") else "user"

    def project(self, unit: str, scope: str) -> str:
        return trusted_project(self.units, unit, scope)

    def persistent(self, unit: str, scope: str) -> bool:
        """A unit file (or its template's) in a unit directory, and no transient unit of that name."""
        head, at, _ = unit.partition("@")
        names = [unit, f"{head}@.service"] if at else [unit]
        if scope == "system":
            transient, dirs = "run/systemd/transient", SYSTEM_UNIT_DIRS
        else:
            transient, dirs = (
                f"run/user/{self.uid}/systemd/transient",
                (f"{self.home.lstrip('/')}/.config/systemd/user", *USER_UNIT_DIRS),
            )
        if os.path.lexists(f"{self.root}/{transient}/{unit}"):
            return False
        return any(os.path.lexists(f"{self.root}/{d}/{n}") for d in dirs for n in names)


def owner(site: dict[str, Any]) -> Owner | None:
    """From the site table (site.owner, site.trusted_units, site.attribution); None (nothing is attributed) when it
    names no owner."""
    import pwd

    try:
        pw = pwd.getpwnam(str(site["owner"]["user"]))
    except (KeyError, OSError, ValueError, TypeError):
        return None
    return Owner(pw.pw_uid, pw.pw_dir, site.get("trusted_units"), settings=site.get("attribution"))


def _read(path: Path, limit: int = 65536) -> bytes:
    try:
        with open(path, "rb") as fh:
            return fh.read(limit)
    except OSError:
        return b""


def _stat(pid: int, proc: Path) -> tuple[str, int]:
    """(comm, ppid); ('', 0) when the process is gone."""
    raw = _read(proc / str(pid) / "stat", 4096).decode(errors="replace")
    head, sep, rest = raw.rpartition(")")
    if not sep:
        return "", 0
    fields = rest.split()
    try:
        return head.partition("(")[2], int(fields[1])
    except (IndexError, ValueError):
        return "", 0


def _argv(pid: int, proc: Path) -> list[str]:
    return [
        a.decode(errors="replace")
        for a in _read(proc / str(pid) / "cmdline", 8192).split(b"\0")
        if a
    ]


def _env(pid: int, proc: Path, keys: tuple[str, ...]) -> dict[str, str]:
    out = {}
    for item in _read(proc / str(pid) / "environ", 262144).split(b"\0"):
        k, sep, v = item.partition(b"=")
        if sep and k.decode(errors="replace") in keys:
            out[k.decode()] = v.decode(errors="replace")
    return out


def _uid(pid: int, proc: Path) -> int:
    for line in _read(proc / str(pid) / "status", 8192).decode(errors="replace").splitlines():
        if line.startswith("Uid:"):
            parts = line.split()
            return int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else -1
    return -1


def _started(pid: int, proc: Path) -> float:
    """Process start, epoch seconds (inf when unknown: never older than anything)."""
    raw = _read(proc / str(pid) / "stat", 4096).decode(errors="replace").rpartition(")")[2].split()
    btime = next(
        (
            ln.split()[1]
            for ln in _read(proc / "stat", 65536).decode(errors="replace").splitlines()
            if ln.startswith("btime ")
        ),
        "",
    )
    try:
        return int(btime) + int(raw[19]) / os.sysconf("SC_CLK_TCK")
    except (IndexError, ValueError, OSError):
        return float("inf")


def _cgroup(pid: int, proc: Path) -> str:
    return (
        _read(proc / str(pid) / "cgroup", 4096).decode(errors="replace").strip().partition("::")[2]
    )


def _session(pid: int, proc: Path, who: Owner) -> tuple[str, str]:
    """(session id, project) the agent process was started with (its environment), "" when not valid."""
    env = _env(pid, proc, (who.env_widget, who.env_project))
    widget = env.get(who.env_widget, "")
    project = env.get(who.env_project, "")
    return (
        widget if WIDGET.fullmatch(widget) else "",
        project if PROJECT.fullmatch(project) else "",
    )


def _where(pid: int, proc: Path) -> str:
    try:
        return os.readlink(proc / str(pid) / "cwd")
    except OSError:
        return ""


def _tool(comm: str, argv: list[str], tools: dict[str, str]) -> str:
    names = {comm, os.path.basename(argv[0]) if argv else ""}
    return next((tools[n] for n in sorted(names) if n in tools), "")


def _runner(chain: list[tuple[str, list[str]]]) -> str:
    """The test or dev runner between the agent and the process, when there is one ('go test', 'pytest', ...)."""
    for comm, argv in chain:
        words = [os.path.basename(a) for a in argv[:4]]
        if comm.endswith(".test"):
            return "go test"
        if comm == "go" and "test" in argv[1:3]:
            return "go test"
        for name in ("pytest", "vitest", "jest", "playwright", "uvicorn", "vite"):
            if (
                name in words
                or name in comm
                or any(a == name or a.endswith(f"/{name}") for a in argv[:4])
            ):
                return name
    return ""


def agent_label(who: Owner, widget: str, tool: str) -> str:
    if widget:
        return who.label_widget.format(widget=widget)
    return who.label_outside.format(tool=tool or "Agent")


def unit_of(cgroup: str) -> str:
    leaf = cgroup.rstrip("/").rsplit("/", 1)[-1]
    return leaf if UNIT.fullmatch(leaf) else ""


def _service(cgroup: str, who: Owner) -> dict[str, Any] | None:
    """Our service behind a cgroup: a trusted unit of that scope (site `trusted_units`), persistent unless it is the
    exact managed rebuild unit of its project."""
    unit = unit_of(cgroup)
    if not unit.endswith(".service"):
        return None
    scope = who.scope(cgroup)
    project = who.project(unit, scope)
    if not project:
        return None
    rebuild = scope == "user" and unit == f"sf-rebuild-{project}.service"
    if not rebuild and not who.persistent(unit, scope):
        return None
    if project in who.own_projects and not rebuild:
        return {"kind": "own", "unit": unit, "label": f"{who.own_projects[project]} ({unit})"}
    return {
        "kind": "summitflow",
        "unit": unit,
        "project": project,
        "label": f"SummitFlow service {unit}",
    }


def of_pid(
    pid: int, who: Owner | None, proc: Path = PROC, root: Path = CGROUP_ROOT
) -> dict[str, Any] | None:
    """The agent session or our service behind a running process of the owner (or a system unit), or None. A process
    with no agent above it (nohup'd or reparented to init) in a scope (tmux pane, terminal) belongs to the owner's agent
    session in that scope that had started before the process did."""
    if who is None:
        return None
    cg = _cgroup(pid, proc)
    if not who.cgroup_ok(cg):
        return None
    chain: list[tuple[str, list[str]]] = []
    seen: list[int] = []
    p = pid
    while p > 1 and p not in seen and len(seen) < MAX_DEPTH:
        seen.append(p)
        comm, ppid = _stat(p, proc)
        if not comm:
            break
        argv = _argv(p, proc)
        tool = _tool(comm, argv, who.tools)
        if tool and _uid(p, proc) == who.uid == _uid(pid, proc):
            widget, project = _session(p, proc, who)
            return {
                "kind": "agent",
                "tool": tool,
                "widget": widget,
                "project": project,
                "via": _runner(chain),
                "cwd": _where(pid, proc)[:160],
                "label": agent_label(who, widget, tool),
            }
        chain.append((comm, argv))
        p = ppid
    svc = _service(cg, who)
    if svc or not unit_of(cg).endswith(".scope") or _uid(pid, proc) != who.uid:
        return svc
    # every ancestor still in the scope must postdate the agent: an editor or shell that started before it (VS Code's
    # language servers, a command typed into the pane's own shell) was not launched by the agent
    start = min((_started(q, proc) for q in seen if _cgroup(q, proc) == cg), default=float("inf"))
    actor = of_cgroup(cg, start, who, root, proc) if start != float("inf") else None
    if actor:
        actor["cwd"] = _where(pid, proc)[:160]
    return actor


def of_cgroup(
    cgroup: str, before: float, who: Owner | None, root: Path = CGROUP_ROOT, proc: Path = PROC
) -> dict[str, Any] | None:
    """The agent or service behind a journal entry's caller cgroup (an entry at epoch `before`): a service unit by its
    name, a scope (tmux pane, terminal) by the owner's agent session running in it that had started by then (a
    session started in that terminal later did not run the command)."""
    if who is None or ".." in cgroup or not who.cgroup_ok(cgroup):
        return None
    unit = unit_of(cgroup)
    svc = _service(cgroup, who)
    if svc:
        return svc
    if not unit.endswith(".scope"):
        return None
    for line in (
        _read(root / cgroup.lstrip("/") / "cgroup.procs", 65536).decode(errors="replace").split()
    ):
        if not line.isdigit():
            continue
        comm, _ = _stat(int(line), proc)
        tool = _tool(comm, _argv(int(line), proc), who.tools) if comm else ""
        if tool and _uid(int(line), proc) == who.uid and _started(int(line), proc) <= before:
            widget, project = _session(int(line), proc, who)
            return {
                "kind": "agent",
                "tool": tool,
                "widget": widget,
                "project": project,
                "via": "",
                "label": agent_label(who, widget, tool),
            }
    return None


def listeners(
    ss_text: str, parse: Any, who: Owner | None, proc: Path = PROC
) -> dict[str, dict[str, Any]]:
    """`ss -tulpnH` text -> {listener key: actor} for the listeners every process of which traces to the same kind of
    actor (one process we cannot trace leaves the listener unattributed). parse = listeners.parse_listeners."""
    pids: dict[str, set[int]] = {}
    for line in ss_text.splitlines():
        key = next(iter(parse(line)), None)
        if key:
            pids.setdefault(key, set()).update(int(x) for x in re.findall(r",pid=(\d+),", line))
    out: dict[str, dict[str, Any]] = {}
    for key, ps in pids.items():
        actors = [of_pid(p, who, proc) for p in sorted(ps)] if who else []
        found = [a for a in actors if a]
        if found and len(found) == len(actors) and len({a["label"] for a in found}) == 1:
            out[key] = found[0]
    return out
