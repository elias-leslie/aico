"""Core tmux primitives: error type, command runner, session name validation, constants."""

from __future__ import annotations

import re
import subprocess

from ...logging_config import get_logger

logger = get_logger(__name__)

TMUX_COMMAND_TIMEOUT = 10  # seconds for tmux subprocess calls
#: Pre-Tether A-Term sessions on the user's default tmux server (attach-only).
TMUX_SESSION_PREFIX = "summitflow-"
_SESSION_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_\-]+$")
_SOCKET_PATH_SEGMENT_PATTERN = re.compile(r"^[a-zA-Z0-9_.\-]+$")
_MAX_UNIX_SOCKET_PATH_BYTES = 107


class TmuxError(Exception):
    """Error interacting with tmux."""


def validate_session_name(name: str) -> bool:
    """Validate tmux session name to prevent injection attacks."""
    return bool(_SESSION_NAME_PATTERN.match(name)) and len(name) < 256


def validate_socket_name(name: str | None) -> bool:
    """Validate a tmux server socket used with ``tmux -S``.

    ``None`` means the user's default server. Anything else must be an
    absolute path (Tether's private server sockets), with conservative segment
    syntax and the Unix socket path length limit.
    """
    if name is None:
        return True
    if not name.startswith("/"):
        return False
    try:
        if len(name.encode()) > _MAX_UNIX_SOCKET_PATH_BYTES:
            return False
    except UnicodeEncodeError:
        return False
    segments = name[1:].split("/")
    return bool(segments) and all(
        segment not in {"", ".", ".."} and bool(_SOCKET_PATH_SEGMENT_PATTERN.fullmatch(segment))
        for segment in segments
    )


def build_tmux_command(args: list[str], socket_name: str | None = None) -> list[str]:
    """Build a tmux command for the default server or an absolute socket path."""
    if not validate_socket_name(socket_name):
        raise TmuxError(f"Invalid tmux socket name: {str(socket_name)[:50]}")
    cmd = ["tmux"]
    if socket_name:
        cmd.extend(["-S", socket_name])
    cmd.extend(args)
    return cmd


def run_tmux_command(
    args: list[str],
    check: bool = False,
    socket_name: str | None = None,
) -> tuple[bool, str]:
    """Run a tmux command with standardized error handling.

    Returns: (success, output_or_error)
    Raises: TmuxError if check=True and command fails
    """
    try:
        cmd = build_tmux_command(args, socket_name)
    except TmuxError as err:
        if check:
            raise
        return False, str(err)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=TMUX_COMMAND_TIMEOUT)
        if result.returncode == 0:
            return True, result.stdout.strip()

        error_msg = result.stderr.strip() or f"tmux exited with code {result.returncode}"
        logger.debug("tmux_command_failed", cmd=args, socket=socket_name, error=error_msg)
        if check:
            raise TmuxError(error_msg)
        return False, error_msg
    except subprocess.TimeoutExpired as err:
        error_msg = f"tmux command timed out after {TMUX_COMMAND_TIMEOUT}s"
        logger.error("tmux_command_timeout", cmd=args, socket=socket_name)
        if check:
            raise TmuxError(error_msg) from err
        return False, error_msg
