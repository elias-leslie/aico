"""The memory event record (schema v1): ~/.local/state/nightshift/memory-events.jsonl.

memctl writes the kernel kills, pane-stopped and outside-hog; Tether's memory guard (packages/tether
src/lifecycle/job-guard.ts) appends its own tool-job kills, warnings and agent-hog records with killer tether.
One JSON object per line, appended and rotated at max_bytes (one older file, .1, is kept):
  kind   kill | warning | pane-stopped | agent-hog | outside-hog
  killer tether | memctl | kernel-pane-cap | kernel-cgroup | kernel-global | oomd   (None for warnings and hogs)
  class  tool | agent | container
plus ts, scope (unit name), tether_session_id, pid, starttime, comm, cmdline_head, bytes, host_state.
Port of ns/memevents.py; the journal readers go through core.run_command so a test hands them fixture output.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from host_steward import core

SCHEMA = 1
KINDS = frozenset({"kill", "warning", "pane-stopped", "agent-hog", "outside-hog"})
KILLERS = frozenset(
    {"tether", "memctl", "kernel-pane-cap", "kernel-cgroup", "kernel-global", "oomd"}
)
CLASSES = frozenset({"tool", "agent", "container"})
FIELDS = (
    "ts",
    "kind",
    "killer",
    "scope",
    "tether_session_id",
    "pid",
    "starttime",
    "comm",
    "cmdline_head",
    "bytes",
    "class",
    "host_state",
)
MAX_BYTES = 2 * 2**20
UNIT_FAILED = (
    "d9b373ed55a64feb8242e02dbe79a49c"  # systemd: unit entered failed state (UNIT_RESULT field)
)
FAILED_RESULTS = (
    "oom-kill",
    "signal",
)  # a pane that ended this way was lost; anything else is a clean end


def read_all(paths: Iterable[Path], since: float | None = None) -> list[dict[str, Any]]:
    """read() over several records, oldest first."""
    return sorted(
        (r for p in dict.fromkeys(paths) for r in read(p, since)),
        key=lambda r: float(r.get("ts") or 0),
    )


def record(kind: str, ts: float, **fields: Any) -> dict[str, Any]:
    """A v1 record: every FIELDS key present (None when unknown); extra keys such as members are kept."""
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind!r}")
    if fields.get("killer") is not None and fields["killer"] not in KILLERS:
        raise ValueError(f"unknown killer {fields['killer']!r}")
    if fields.get("class") is not None and fields["class"] not in CLASSES:
        raise ValueError(f"unknown class {fields['class']!r}")
    rec: dict[str, Any] = {"v": SCHEMA, **dict.fromkeys(FIELDS), **fields}
    rec["ts"], rec["kind"] = round(float(ts), 3), kind
    return rec


def append(path: Path, rec: dict[str, Any], max_bytes: int = MAX_BYTES) -> None:
    """Append one line; first move a file of max_bytes or more to <name>.1 (replacing the older one)."""
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    with contextlib.suppress(FileNotFoundError):
        if path.stat().st_size >= max_bytes:
            os.replace(path, path.with_name(path.name + ".1"))
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(rec, separators=(",", ":")) + "\n")


def read(path: Path, since: float | None = None) -> list[dict[str, Any]]:
    """Records from <name>.1 then <name>, oldest first; unreadable lines are skipped."""
    out = []
    for p in (path.with_name(path.name + ".1"), path):
        with contextlib.suppress(OSError):
            for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
                with contextlib.suppress(ValueError):
                    rec = json.loads(line)
                    if isinstance(rec, dict) and (
                        since is None or float(rec.get("ts") or 0) > since
                    ):
                        out.append(rec)
    return out


_KV = re.compile(r"(\w+)=([^,]*)")
_KILLED = re.compile(
    r"Killed process (\d+) \((.*)\) total-vm:\d+kB, anon-rss:(\d+)kB, file-rss:\d+kB, shmem-rss:(\d+)kB"
    r".*?oom_score_adj:(-?\d+)"
)


def unit_of(memcg: str) -> str | None:
    """The unit a cgroup path is in: the part after the last slice (a sub-cgroup of a pane is still the pane)."""
    parts = [x for x in memcg.split("/") if x]
    last_slice = max((i for i, x in enumerate(parts) if x.endswith(".slice")), default=-1)
    return parts[last_slice + 1] if last_slice + 1 < len(parts) else (parts[-1] if parts else None)


def kernel_killer(constraint: str, oom_memcg: str) -> str:
    """kernel-pane-cap when a pane scope's own limit was hit, kernel-cgroup for another cgroup's limit, else global."""
    if constraint != "CONSTRAINT_MEMCG":
        return "kernel-global"
    name = oom_memcg.rsplit("/", 1)[-1]
    return (
        "kernel-pane-cap"
        if name.startswith("tmux-spawn-") and name.endswith(".scope")
        else "kernel-cgroup"
    )


def parse_kernel(lines: Iterable[tuple[float, str]]) -> list[dict[str, Any]]:
    """Kernel log (ts, message) -> one kill per `oom-kill:` line, joined with its `Killed process` line by pid:
    {ts, pid, comm, scope (task_memcg's unit), task_memcg, killer, bytes (anon+shmem rss), oom_score_adj}."""
    kills: dict[int, dict[str, Any]] = {}
    for ts, msg in lines:
        if msg.startswith("oom-kill:"):
            kv = dict(_KV.findall(msg[len("oom-kill:") :]))
            with contextlib.suppress(KeyError, ValueError):
                pid, memcg = int(kv["pid"]), kv.get("task_memcg", "")
                kills[pid] = {
                    "ts": ts,
                    "pid": pid,
                    "comm": kv.get("task"),
                    "task_memcg": memcg,
                    "scope": unit_of(memcg),
                    "killer": kernel_killer(kv.get("constraint", ""), kv.get("oom_memcg", "")),
                    "bytes": None,
                    "oom_score_adj": None,
                }
        elif (m := _KILLED.search(msg)) and int(m[1]) in kills:
            kill = kills[int(m[1])]
            kill["comm"] = m[2]
            kill["bytes"] = (int(m[3]) + int(m[4])) * 1024
            kill["oom_score_adj"] = int(m[5])
    return sorted(kills.values(), key=lambda k: k["ts"])


def kernel_lines(lines: Iterable[str]) -> list[tuple[float, str]]:
    """`journalctl -k -o json` lines -> (ts, message) of the oom-kill lines, for parse_kernel."""
    out = []
    for line in lines:
        with contextlib.suppress(ValueError, KeyError, TypeError):
            d = json.loads(line)
            msg = d["MESSAGE"]
            if isinstance(msg, str) and ("oom-kill:" in msg or "Killed process" in msg):
                out.append((int(d["__REALTIME_TIMESTAMP"]) / 1e6, msg))
    return out


def journal_kernel(
    since: float, run: core.Runner = core.run_command, timeout: float = 10.0
) -> list[tuple[float, str]] | None:
    """Kernel journal oom lines since `since` (epoch s); None when journalctl fails."""
    res = run(
        ["journalctl", "-k", "-o", "json", "--no-pager", "-q", "--since", f"@{int(since)}"],
        timeout=timeout,
    )
    return kernel_lines(res.out.splitlines()) if res.rc == 0 else None


def unit_result(
    unit: str, since: float, run: core.Runner = core.run_command, timeout: float = 10.0
) -> tuple[bool, str | None]:
    """(read, result): the last failed result the user manager logged for unit since `since`, None when it logged
    none (the unit ended cleanly or still runs); read False when journalctl failed."""
    res = run(
        [
            "journalctl",
            "--user",
            "-o",
            "json",
            "--output-fields=UNIT_RESULT,USER_UNIT",
            "-q",
            "--no-pager",
            "--since",
            f"@{int(since)}",
            f"USER_UNIT={unit}",
            f"MESSAGE_ID={UNIT_FAILED}",
        ],
        timeout=timeout,
    )
    if res.rc != 0:
        return False, None
    result = None
    for line in res.out.splitlines():
        with contextlib.suppress(ValueError, TypeError, AttributeError):
            d = json.loads(line)
            if d.get("USER_UNIT") == unit and isinstance(d.get("UNIT_RESULT"), str):
                result = d["UNIT_RESULT"]
    return True, result
