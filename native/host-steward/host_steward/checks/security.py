"""Docker access (agent boundary B3): group docker is root-equivalent, so nobody may be in it and docker.sock stays
root:docker 0660.

Port of ns/checks/docker_access.py (the "security" check's third part; the tripwire and sudo are checks of their
own). One signal per pass; the container-create watcher it replaced is gone.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Callable
from pathlib import Path

from host_steward.core import Ctx, Signal

ID = "security"


def check(group_file: str, sock: str, stat_fn: Callable[[str], os.stat_result] = os.stat) -> Signal:
    gid, members = None, []
    for line in Path(group_file).read_text().splitlines():
        f = line.split(":")
        if len(f) >= 4 and f[0] == "docker":
            gid, members = int(f[2]), [m for m in f[3].split(",") if m]
    problems = [f"group docker has members: {', '.join(members)}"] if members else []
    try:
        st = stat_fn(sock)
    except FileNotFoundError:  # docker not running: nothing to open
        st = None
    if st is not None and (
        not stat.S_ISSOCK(st.st_mode)
        or st.st_uid != 0
        or st.st_gid != gid
        or stat.S_IMODE(st.st_mode) != 0o660
    ):
        problems.append(
            f"{sock} is {st.st_uid}:{st.st_gid} {stat.S_IMODE(st.st_mode):04o}, not root:docker 0660"
        )
    if problems:
        return Signal("security.docker", "warn", {"problems": "; ".join(problems)})
    return Signal("security.docker", "ok")


def run(ctx: Ctx) -> list[Signal]:
    try:
        return [check(ctx.cfg["group_file"], ctx.cfg["socket"])]
    except (OSError, ValueError) as error:
        return [Signal("security.docker.unreadable", "warn", {"why": str(error)[:80]})]
