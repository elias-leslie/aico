"""Tmux session naming, existence checks, creation, and listing."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import uuid as _uuid_mod
from pathlib import Path

from ...logging_config import get_logger
from .core import (
    FILTERED_ENV_VARS,
    TMUX_COMMAND_TIMEOUT,
    TMUX_SESSION_PREFIX,
    TmuxError,
)

logger = get_logger(__name__)


def _pkg() -> object:
    """Return the aterm.utils.tmux package module (avoids circular import)."""
    return sys.modules["aterm.utils.tmux"]


def get_tmux_session_name(session_id: str) -> str:
    """Convert session ID to tmux session name."""
    return f"{TMUX_SESSION_PREFIX}{session_id}"


def _is_valid_uuid(value: str) -> bool:
    """Check if a string is a valid UUID."""
    try:
        _uuid_mod.UUID(value)
        return True
    except ValueError:
        return False


def is_managed_tmux_session_name(session_name: str) -> bool:
    """Return True when the tmux session belongs to A-Term-managed UUID sessions."""
    return (
        session_name.startswith(TMUX_SESSION_PREFIX)
        and _is_valid_uuid(session_name[len(TMUX_SESSION_PREFIX):])
    )


def tmux_session_exists_by_name(session_name: str) -> bool:
    """Check if a tmux session exists by its direct name."""
    pkg = _pkg()
    success, _ = pkg.run_tmux_command(["has-session", "-t", session_name])  # type: ignore[union-attr]
    return success


def tmux_session_exists(session_id: str) -> bool:
    """Check if a tmux session exists."""
    pkg = _pkg()
    return pkg.tmux_session_exists_by_name(  # type: ignore[union-attr]
        pkg.get_tmux_session_name(session_id)  # type: ignore[union-attr]
    )


def _apply_session_options(session_name: str, disable_mouse: bool = True) -> None:
    """Apply session options: mouse off, status off, filter secret env vars.

    Batches all options into a single tmux command using ';' chaining
    to avoid 14+ separate subprocess.run() calls.
    """
    pkg = _pkg()
    args: list[str] = []
    if disable_mouse:
        args.extend(["set-option", "-t", session_name, "mouse", "off", ";"])
    args.extend(["set-option", "-t", session_name, "status", "off", ";"])
    args.extend(["set-option", "-t", session_name, "history-limit", "50000"])
    for var in FILTERED_ENV_VARS:
        args.extend([";", "set-environment", "-t", session_name, "-u", var])
    pkg.run_tmux_command(args)  # type: ignore[union-attr]
    logger.debug("session_configured", session=session_name, filtered_vars=len(FILTERED_ENV_VARS))


def _recreate_initial_window_with_session_history_limit(
    session_name: str,
    working_dir: str,
) -> None:
    """Replace tmux's bootstrap window after history-limit is configured.

    tmux applies history-limit when a window is created. The initial window
    created by ``new-session`` keeps the server default (2000 here) even if the
    session option is changed immediately afterward, so create a replacement
    window once the session options are in place.
    """
    pkg = _pkg()
    _, bootstrap_window_index = pkg.run_tmux_command(  # type: ignore[union-attr]
        ["display-message", "-p", "-t", session_name, "#{window_index}"],
        check=True,
    )
    _, replacement_window_index = pkg.run_tmux_command(  # type: ignore[union-attr]
        [
            "new-window",
            "-dP",
            "-F",
            "#{window_index}",
            "-t",
            session_name,
            "-c",
            working_dir,
        ],
        check=True,
    )
    pkg.run_tmux_command(  # type: ignore[union-attr]
        ["select-window", "-t", f"{session_name}:{replacement_window_index}"],
        check=True,
    )
    pkg.run_tmux_command(  # type: ignore[union-attr]
        ["kill-window", "-t", f"{session_name}:{bootstrap_window_index}"],
        check=True,
    )
    logger.debug(
        "tmux_initial_window_recreated",
        session=session_name,
        bootstrap_window_index=bootstrap_window_index,
        replacement_window_index=replacement_window_index,
    )


def _can_spawn_tmux_scope() -> bool:
    """Return True when a user manager is available for scoped tmux session creation."""
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return shutil.which("systemd-run") is not None and (Path(runtime_dir) / "systemd/private").exists()


def _run_tmux_new_session(args: list[str], session_name: str) -> tuple[bool, str]:
    """Create a tmux session from a transient user scope when user systemd is available."""
    pkg = _pkg()
    if not pkg._can_spawn_tmux_scope():  # type: ignore[union-attr]
        return pkg.run_tmux_command(args)  # type: ignore[union-attr]

    scope_id = _uuid_mod.uuid4()
    cmd = [
        "systemd-run",
        "--user",
        "--scope",
        "--quiet",
        f"--unit=tmux-spawn-{scope_id}",
        f"--description=aterm tmux session spawn {session_name}",
        "tmux",
        *args,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=TMUX_COMMAND_TIMEOUT)
    except subprocess.TimeoutExpired:
        error_msg = f"tmux session spawn timed out after {TMUX_COMMAND_TIMEOUT}s"
        logger.error("tmux_scoped_create_timeout", session=session_name)
        return False, error_msg

    if result.returncode == 0:
        return True, result.stdout.strip()

    error_msg = result.stderr.strip() or f"systemd-run exited with code {result.returncode}"
    logger.debug("tmux_scoped_create_failed", session=session_name, error=error_msg)
    return False, error_msg


def create_tmux_session(
    session_id: str,
    working_dir: str | None = None,
    disable_mouse: bool = True,
) -> str:
    """Create or reconfigure a tmux session.

    Returns: tmux session name
    Raises: TmuxError if session creation fails
    """
    from ...config import TMUX_DEFAULT_COLS, TMUX_DEFAULT_ROWS

    pkg = _pkg()
    session_name = pkg.get_tmux_session_name(session_id)  # type: ignore[union-attr]

    # If session exists, reconfigure and return
    if pkg.tmux_session_exists(session_id):  # type: ignore[union-attr]
        logger.info("tmux_session_exists", session=session_name)
        pkg._apply_session_options(session_name, disable_mouse)  # type: ignore[union-attr]
        return session_name

    # Create new session
    effective_working_dir = working_dir or os.path.expanduser("~")
    args = [
        "new-session",
        "-d",
        "-s",
        session_name,
        "-x",
        str(TMUX_DEFAULT_COLS),
        "-y",
        str(TMUX_DEFAULT_ROWS),
        "-c",
        effective_working_dir,
    ]

    success, output = pkg._run_tmux_new_session(args, session_name)  # type: ignore[union-attr]
    if not success:
        logger.error("tmux_create_failed", session=session_name, error=output)
        raise TmuxError(f"Failed to create tmux session: {output}")

    pkg._apply_session_options(session_name, disable_mouse)  # type: ignore[union-attr]
    _recreate_initial_window_with_session_history_limit(session_name, effective_working_dir)
    logger.info("tmux_session_created", session=session_name, working_dir=effective_working_dir)
    return session_name


def list_tmux_sessions() -> set[str]:
    """List all summitflow tmux sessions (returns session IDs without prefix).

    Only includes sessions whose extracted ID is a valid UUID,
    preventing non-aterm sessions from polluting reconciliation.
    """
    pkg = _pkg()
    success, output = pkg.run_tmux_command(["list-sessions", "-F", "#{session_name}"])  # type: ignore[union-attr]

    if not success:
        return set()

    result: set[str] = set()
    for line in output.split("\n"):
        if not line.startswith(TMUX_SESSION_PREFIX):
            continue
        session_id = line[len(TMUX_SESSION_PREFIX):]
        if _is_valid_uuid(session_id):
            result.add(session_id)
        else:
            logger.debug("skipping_non_uuid_tmux_session", session_name=line)
    return result
