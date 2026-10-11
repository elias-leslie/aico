"""Legacy A-Term sessions on the user's default tmux server.

Before Tether, A-Term created ``summitflow-<uuid>`` sessions on the default
server. They stay attach-only until they end: A-Term lists, attaches to and
can End them, but never creates, respawns or resets one. New sessions are
created by Tether on private servers.
"""

from __future__ import annotations

import sys
import uuid as _uuid_mod

from ...logging_config import get_logger
from .core import TMUX_SESSION_PREFIX

logger = get_logger(__name__)


def _pkg() -> object:
    """Return the a_term.utils.tmux package module (avoids circular import)."""
    return sys.modules["a_term.utils.tmux"]


def get_tmux_session_name(session_id: str) -> str:
    """tmux session name of a legacy A-Term session."""
    return f"{TMUX_SESSION_PREFIX}{session_id}"


def _is_valid_uuid(value: str) -> bool:
    try:
        _uuid_mod.UUID(value)
        return True
    except ValueError:
        return False


def is_managed_tmux_session_name(session_name: str) -> bool:
    """Return True for a legacy ``summitflow-<uuid>`` session name."""
    return session_name.startswith(TMUX_SESSION_PREFIX) and _is_valid_uuid(
        session_name[len(TMUX_SESSION_PREFIX) :]
    )


def tmux_session_exists_by_name(session_name: str, socket_name: str | None = None) -> bool:
    """Check whether a session exists on the default server or ``socket_name``."""
    pkg = _pkg()
    success, _ = pkg.run_tmux_command(  # type: ignore[union-attr]
        ["has-session", "-t", f"={session_name}"], socket_name=socket_name
    )
    return success


def tmux_session_exists(session_id: str) -> bool:
    """Check whether a legacy session still runs on the default server."""
    pkg = _pkg()
    return pkg.tmux_session_exists_by_name(  # type: ignore[union-attr]
        pkg.get_tmux_session_name(session_id)  # type: ignore[union-attr]
    )


def list_tmux_sessions() -> set[str]:
    """UUIDs of the legacy A-Term sessions still running on the default server."""
    pkg = _pkg()
    success, output = pkg.run_tmux_command(["list-sessions", "-F", "#{session_name}"])  # type: ignore[union-attr]
    if not success:
        return set()
    result: set[str] = set()
    for line in output.split("\n"):
        if is_managed_tmux_session_name(line):
            result.add(line[len(TMUX_SESSION_PREFIX) :])
    return result


def kill_legacy_session(session_id: str) -> bool:
    """End a legacy session. Returns False if it was already gone."""
    pkg = _pkg()
    name = pkg.get_tmux_session_name(session_id)  # type: ignore[union-attr]
    success, error = pkg.run_tmux_command(["kill-session", "-t", f"={name}"])  # type: ignore[union-attr]
    if not success:
        lowered = error.lower()
        if "can't find session" in lowered or "session not found" in lowered or "no server running" in lowered:
            return False
        raise pkg.TmuxError(f"Failed to end legacy session: {error}")  # type: ignore[union-attr]
    logger.info("legacy_tmux_session_ended", session=name)
    return True
