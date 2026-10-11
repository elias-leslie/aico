"""PTY management for WebSocket views.

A view is a PTY running a tmux client attached to the session: Tether's exact
``tmux -S <socket> attach-session -t <target>`` argv for Tether sessions, or a
default-server attach for legacy and external sessions. Tether never proxies
terminal bytes; A-Term keeps its own byte path.
"""

from __future__ import annotations

import asyncio
import fcntl
import os
import pty
import struct
import termios
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from ..logging_config import get_logger
from ._pty_reader import _make_on_readable, _run_batch_loop

if TYPE_CHECKING:
    from fastapi import WebSocket

    from .backpressure import BackpressureController
    from .diagnostics import SessionDiagnostics

logger = get_logger(__name__)

__all__ = ["attach_environment", "read_pty_output", "resize_pty", "spawn_pty"]

# Never let the client inherit a parent tmux or a colour veto. Tether's attach
# ``unset`` list names these too (and may add more); legacy and external
# attaches, which get no list from Tether, use this one.
_DROPPED_ENV = ("TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NO_COLOR")


def attach_environment(
    overrides: dict[str, str] | None = None, unset: list[str] | tuple[str, ...] | None = None
) -> dict[str, str]:
    """Client environment per Tether's attach contract.

    ``overrides`` (Tether's ``env``) are set over our own environment, then
    every key in ``unset`` and in the built-in list is removed.
    """
    env = dict(os.environ)
    env.update(overrides or {})
    for key in (*_DROPPED_ENV, *(unset or ())):
        env.pop(key, None)
    env.setdefault("TERM", "xterm-256color")
    return env


def spawn_pty(
    argv: list[str], env: dict[str, str] | None = None, unset: list[str] | None = None
) -> tuple[int, int]:
    """Fork a PTY whose child execs ``argv`` (a tmux attach). Returns (master_fd, pid).

    The child pid is the tmux client's pid, which Tether's resize claim needs.
    """
    if not argv or not isinstance(argv[0], str):
        raise ValueError("Empty attach argv")
    child_env = attach_environment(env, unset)
    pid, master_fd = pty.fork()
    if pid == 0:  # pragma: no cover - child process
        try:
            os.execvpe(argv[0], argv, child_env)
        finally:
            os._exit(127)
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    return master_fd, pid


def resize_pty(master_fd: int, cols: int, rows: int) -> None:
    """Resize the view's own PTY (and so its tmux client)."""
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)


async def read_pty_output(
    websocket: WebSocket,
    master_fd: int,
    session_id: str = "",
    on_flush: Callable[[str], Awaitable[None]] | None = None,
    backpressure: BackpressureController | None = None,
    use_binary: bool = False,
    diag: SessionDiagnostics | None = None,
) -> None:
    """Read PTY output and send it to the WebSocket in 16 ms / 4 KB batches."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=256)
    on_readable = _make_on_readable(master_fd, queue, session_id=session_id)
    loop.add_reader(master_fd, on_readable)
    try:
        await _run_batch_loop(websocket, queue, loop, on_flush, backpressure, use_binary, diag)
    finally:
        loop.remove_reader(master_fd)
