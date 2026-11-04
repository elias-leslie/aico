"""How a controller that changes the host does it: one Actor, one place that decides to act or only to say so.

Every change a housekeeping, space-guard, scrub or self-test job makes goes through Actor.do (a command) or
Actor.apply (a Python change). With the switch off (checks.toml [acting]) nothing runs: the label goes on
`would`, which the job prints and posts as "Dry run: ...". With it on the change is made and the label goes on
`did`. Read-only looks (btrfs usage, findmnt, pgrep, du) are never routed through here; they run in both modes.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import logging
from collections.abc import Callable, Generator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from host_steward import core

log = logging.getLogger("host-steward")


@dataclass
class Actor:
    live: bool
    run: core.Runner = core.run_command
    did: list[str] = field(default_factory=list)
    would: list[str] = field(default_factory=list)

    def do(
        self, argv: list[str], label: str | None = None, timeout: float = 60, quiet: bool = False
    ) -> core.Result | None:
        """Run a command that changes something. None (and a `would` line unless quiet) while the switch is off."""
        text = label or " ".join(argv)
        if not self.live:
            if not quiet:
                self.would.append(text)
            return None
        result = self.run(argv, timeout=timeout)
        log.info("ran %s (exit %s)", " ".join(argv[:4]), result.rc)
        return result

    def apply(self, label: str, change: Callable[[], Any]) -> tuple[bool, Any]:
        """Make a change in Python (delete a directory, create a file). (False, None) while the switch is off."""
        if not self.live:
            self.would.append(label)
            return False, None
        return True, change()


def job_dir() -> Path:
    """Where the jobs keep their own files, next to the check state."""
    return core.STATE_PATH.parent / "jobs"


def read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


write_json = core.write_json


@contextlib.contextmanager
def single_run(name: str) -> Generator[bool]:
    """True when this process holds the job's lock; False when another run of the same job is still going."""
    lock = job_dir() / f"{name}.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True


def owner_env(user: str) -> tuple[str, list[str]] | None:
    """(the owner's uid text, the clean login-like environment words) for a command run as the owner."""
    import pwd

    try:
        entry = pwd.getpwnam(user)
    except KeyError:
        return None
    home = entry.pw_dir
    env = [
        "env",
        "-i",
        f"HOME={home}",
        f"USER={user}",
        f"LOGNAME={user}",
        f"XDG_RUNTIME_DIR=/run/user/{entry.pw_uid}",
        f"PATH={home}/bin:{home}/.local/bin:/usr/local/bin:/usr/bin:/bin",
    ]
    return home, env


def as_owner(user: str, cmd: list[str]) -> list[str] | None:
    """`cmd` wrapped to run as the owner; None when the owner does not exist on this machine."""
    found = owner_env(user)
    return None if found is None else ["runuser", "-u", user, "--", *found[1], *cmd]


def say_would(would: list[str], limit: int = 3) -> str:
    shown = "; ".join(would[:limit])
    return shown + (f"; and {len(would) - limit} more" if len(would) > limit else "")
