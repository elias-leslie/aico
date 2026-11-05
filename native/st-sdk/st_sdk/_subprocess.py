"""Owned CLI subprocess execution and cancellation for admission children."""

from __future__ import annotations

import contextlib
import os
import shutil
import signal
import subprocess
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

StrPath = str | os.PathLike[str]


def _resolve_executable(executable: str, env: Mapping[str, str] | None = None) -> str:
    path = Path(executable).expanduser()
    if path.is_absolute():
        return str(path)
    if os.sep in executable:
        resolved = path.resolve()
        if resolved.exists():
            return str(resolved)
        raise FileNotFoundError(executable)
    found = shutil.which(executable, path=(env or os.environ).get("PATH"))
    if found:
        return found
    raise FileNotFoundError(executable)


def _argv(args: Sequence[StrPath], env: Mapping[str, str] | None = None) -> list[str]:
    argv = [str(arg) for arg in args]
    if not argv:
        raise ValueError("subprocess args cannot be empty")
    argv[0] = _resolve_executable(argv[0], env)
    return argv


# Per-signal wait for the owned subtree to exit and release captured pipes.
_STOP_SIGNAL_GRACE_SECONDS = 2.0


def _stop_cli_owned_process(process: subprocess.Popen[Any]) -> None:
    """Cancel only the CLI's captured owned subtree, including new sessions."""
    def identity(pid: int) -> tuple[int, int, str]:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return int(fields[1]), int(fields[2]), fields[19]

    snapshot: dict[int, tuple[int, int, str]] = {}

    def alive(pid: int) -> bool:
        try:
            return pid in snapshot and identity(pid)[2] == snapshot[pid][2]
        except (OSError, ValueError):
            return False

    def signal_owned(sig: int, owned: set[int]) -> None:
        # The initial group remains ours after its leader exits. Pipe-holding
        # children must not defeat timeout, but unrelated groups are not ours.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, sig)
        for pid in [*sorted(owned - {process.pid}), process.pid]:
            if alive(pid):
                with contextlib.suppress(ProcessLookupError):
                    os.kill(pid, sig)

    # Freeze before signaling: a live owner can fork a new-session child after
    # a /proc scan and then die, orphaning it outside the captured subtree.
    # Stopped processes cannot fork, so rescanning until no new owned process
    # appears captures the whole subtree while parent links still hold.
    owned = {process.pid}
    stopped: set[int] = set()
    while True:
        current: dict[int, tuple[int, int, str]] = {}
        for entry in Path("/proc").iterdir():
            if entry.name.isdigit():
                with contextlib.suppress(OSError, ValueError):
                    current[int(entry.name)] = identity(int(entry.name))
        # Owned identities stay pinned to first sight, so a reused PID is never signaled.
        snapshot = {**current, **{pid: snapshot[pid] for pid in owned if pid in snapshot}}
        # Group members whose parent exited are still ours, as are their children.
        owned |= {pid for pid, (_parent, group, _start) in snapshot.items() if group == process.pid}
        while additions := {pid for pid, (parent, _group, _start) in snapshot.items() if parent in owned} - owned:
            owned.update(additions)
        if owned <= stopped:
            break
        stopped |= owned
        signal_owned(signal.SIGSTOP, owned)

    for sig in (signal.SIGTERM, signal.SIGKILL):
        signal_owned(sig, owned)
        if sig == signal.SIGTERM:
            # Stopped owners must resume to act on SIGTERM, e.g. reap children.
            signal_owned(signal.SIGCONT, owned)
        try:
            process.communicate(timeout=_STOP_SIGNAL_GRACE_SECONDS)
            if not any(alive(pid) for pid in owned - {process.pid}):
                return
        except subprocess.TimeoutExpired:
            pass
    # Already-reparented detached sessions are outside the captured subtree.
    # Bound the final drain; never broaden signaling to unrelated processes.
    try:
        process.communicate(timeout=0)
    except subprocess.TimeoutExpired:
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()
        process.wait(timeout=2)


def run_cli_owned(
    args: Sequence[StrPath], *, inherit_fds: Sequence[int], **kwargs: Any,
) -> subprocess.CompletedProcess[Any]:
    """CLI only: own a new session and its synchronous capture/timeout cleanup.

    Unlike run()/run_inherited(), this may use Python fork. Resident ASGI/task
    callers must keep using those native-spawn adapters, never this one.
    """
    if kwargs.pop("shell", False) or kwargs.get("preexec_fn") is not None:
        raise ValueError("Owned CLI execution requires argv without preexec_fn")
    if "pass_fds" in kwargs or "start_new_session" in kwargs:
        raise ValueError("Owned CLI execution controls descriptor and session ownership")
    check = kwargs.pop("check", False)
    timeout = kwargs.pop("timeout", None)
    data = kwargs.pop("input", None)
    if kwargs.pop("capture_output", False):
        if "stdout" in kwargs or "stderr" in kwargs:
            raise ValueError("capture_output conflicts with stdout or stderr")
        kwargs["stdout"] = subprocess.PIPE
        kwargs["stderr"] = subprocess.PIPE
    if data is not None:
        if "stdin" in kwargs:
            raise ValueError("stdin and input cannot both be supplied")
        kwargs["stdin"] = subprocess.PIPE
    argv = _argv(args, kwargs.get("env"))
    with subprocess.Popen(argv, pass_fds=inherit_fds, start_new_session=True, **kwargs) as process:
        try:
            stdout, stderr = process.communicate(data, timeout=timeout)
        except BaseException:
            _stop_cli_owned_process(process)
            raise
    result = subprocess.CompletedProcess(list(args), process.returncode, stdout, stderr)
    if check:
        result.check_returncode()
    return result


