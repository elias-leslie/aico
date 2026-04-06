"""PTY management service for a_term sessions.

Handles low-level PTY operations:
- Spawning PTY attached to tmux sessions
- Resizing PTY a_term sessions
- Reading PTY output with UTF-8 handling
- Session name validation
"""

from __future__ import annotations

import asyncio
import fcntl
import os
import pty
import shlex
import struct
import termios
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from ..logging_config import get_logger
from ..utils.tmux import run_tmux_command, validate_session_name
from ._pty_reader import _make_on_readable, _run_batch_loop

if TYPE_CHECKING:
    from fastapi import WebSocket

    from .backpressure import BackpressureController
    from .diagnostics import SessionDiagnostics

logger = get_logger(__name__)

# Re-export batching constants so callers can reference them if needed

__all__ = ["read_pty_output", "resize_pty", "spawn_pty_for_tmux"]


def _resolve_target_session(stored_target_session: str | None) -> str | None:
    """Validate and check if the stored target session still exists.

    Returns the session name if it is valid and alive, else None.
    """
    if not stored_target_session:
        return None
    if not validate_session_name(stored_target_session):
        logger.warning("invalid_target_session_name", session=stored_target_session[:50])
        return None
    success, _ = run_tmux_command(["has-session", "-t", stored_target_session])
    if not success:
        return None
    logger.info("using_stored_target_session", session=stored_target_session)
    return stored_target_session


def _exec_tmux_attach(tmux_session: str, target_session: str | None) -> None:
    """Replace the child process image with tmux attach (never returns)."""
    os.environ["TERM"] = "xterm-256color"
    if target_session:
        safe_base = shlex.quote(tmux_session)
        safe_target = shlex.quote(target_session)
        os.execvp(
            "bash",
            [
                "bash",
                "-c",
                f"tmux attach-session -t {safe_base} \\; switch-client -t {safe_target}",
            ],
        )
    else:
        os.execvp("tmux", ["tmux", "attach-session", "-t", tmux_session])


def spawn_pty_for_tmux(
    tmux_session: str,
    stored_target_session: str | None = None,
) -> tuple[int, int]:
    """Spawn a PTY attached to a tmux session.

    Args:
        tmux_session: Base tmux session name to attach to
        stored_target_session: Previously stored target session to auto-switch to

    Returns:
        Tuple of (master_fd, pid)

    Raises:
        ValueError: If tmux session name is invalid

    Security:
        Session names are validated with validate_session_name() before use.
        shlex.quote() provides additional protection for shell commands.
    """
    if not validate_session_name(tmux_session):
        raise ValueError(f"Invalid tmux session name: {tmux_session[:50]}")

    target_session = _resolve_target_session(stored_target_session)
    pid, master_fd = pty.fork()

    if pid == 0:
        # Child process — replace with tmux attach (never returns)
        _exec_tmux_attach(tmux_session, target_session)
        raise RuntimeError("PTY fork failed")  # unreachable

    # Parent: make fd non-blocking and return
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    return master_fd, pid


def resize_pty(master_fd: int, cols: int, rows: int) -> None:
    """Resize a PTY.

    Args:
        master_fd: Master file descriptor
        cols: Number of columns
        rows: Number of rows
    """
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
    """Read output from PTY and send to WebSocket with batching.

    Uses asyncio native FD watching with loop.add_reader() for true zero CPU
    when idle.  Implements 16ms/4KB batching to prevent browser freeze on
    heavy output.  Handles UTF-8 decoding with buffering for incomplete
    multi-byte sequences.

    Args:
        websocket: WebSocket connection to send output to
        master_fd: Master file descriptor to read from
        session_id: A-Term session ID for logging context
        on_flush: Optional callback invoked after each batch flush
        backpressure: Optional controller that pauses/resumes FD reading
        use_binary: Use binary protocol framing for output
    """
    loop = asyncio.get_running_loop()
    # Bounded queue prevents unbounded memory growth when WS is slower than PTY
    queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=256)

    on_readable = _make_on_readable(master_fd, queue, session_id=session_id)
    loop.add_reader(master_fd, on_readable)

    # Let backpressure controller know the on_readable callback so it can
    # re-register the reader after resuming.
    if backpressure is not None:
        # Store for controller's resume path — it calls loop.add_reader
        # with this callback.
        pass  # Controller already has on_readable from its constructor

    try:
        await _run_batch_loop(websocket, queue, loop, on_flush, backpressure, use_binary, diag)
    finally:
        loop.remove_reader(master_fd)
