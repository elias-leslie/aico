"""Attach state: normalize a session's tmux UI (status, mouse) while A-Term is attached.

Options are refcounted per session and restored when the last View detaches.
Discovering the user's own sessions is the session catalog's job (its Own
tmux adapter), not this module's.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from threading import Lock

from ...logging_config import get_logger

logger = get_logger(__name__)

_EXTERNAL_ATTACH_LOCK = Lock()
_EXTERNAL_ATTACH_STATES: dict[str, _ExternalAttachState] = {}


@dataclass
class _ExternalAttachState:
    refcount: int
    status: str
    mouse: str
    socket_name: str | None = None


def _pkg() -> object:
    """Return the a_term.utils.tmux package module (avoids circular import)."""
    return sys.modules["a_term.utils.tmux"]


def _normalize_tmux_toggle(value: str) -> str | None:
    normalized = value.strip().lower()
    if normalized in {"on", "1", "yes"}:
        return "on"
    if normalized in {"off", "0", "no"}:
        return "off"
    return None


def get_tmux_session_option(
    session_name: str,
    option: str,
    socket_name: str | None = None,
) -> str | None:
    """Return the effective session option value normalized to on/off."""
    pkg = _pkg()
    commands = (
        ["show-options", "-qv", "-t", session_name, option],
        ["show-options", "-gqv", option],
    )
    for args in commands:
        if socket_name:
            success, output = pkg.run_tmux_command(args, socket_name=socket_name)  # type: ignore[union-attr]
        else:
            success, output = pkg.run_tmux_command(args)  # type: ignore[union-attr]
        if not success or not output.strip():
            continue
        normalized = _normalize_tmux_toggle(output)
        if normalized:
            return normalized

    logger.warning(
        "tmux_option_read_failed",
        session=session_name,
        socket=socket_name,
        option=option,
    )
    return None


def set_tmux_session_option(
    session_name: str,
    option: str,
    value: str,
    socket_name: str | None = None,
) -> bool:
    """Set a tmux session option to a normalized on/off value."""
    pkg = _pkg()
    args = ["set-option", "-t", session_name, option, value]
    if socket_name:
        success, _ = pkg.run_tmux_command(args, socket_name=socket_name)  # type: ignore[union-attr]
    else:
        success, _ = pkg.run_tmux_command(args)  # type: ignore[union-attr]
    if success:
        logger.debug("tmux_option_set", session=session_name, option=option, value=value)
    else:
        logger.warning("tmux_option_set_failed", session=session_name, option=option, value=value)
    return success


def apply_external_attach_options(session_name: str, socket_name: str | None = None) -> bool:
    """Normalize external tmux UI while A-Term is attached."""
    pkg = _pkg()
    with _EXTERNAL_ATTACH_LOCK:
        state_key = f"{socket_name or 'default'}:{session_name}"
        existing = _EXTERNAL_ATTACH_STATES.get(state_key)
        if existing:
            existing.refcount += 1
            logger.debug(
                "tmux_external_attach_reused",
                session=session_name,
                socket=socket_name,
                refcount=existing.refcount,
            )
            return True

        status = pkg.get_tmux_session_option(session_name, "status", socket_name)  # type: ignore[union-attr]
        mouse = pkg.get_tmux_session_option(session_name, "mouse", socket_name)  # type: ignore[union-attr]
        if status is None or mouse is None:
            return False

        changed_options: list[tuple[str, str]] = []
        for option, original_value in (("status", status), ("mouse", mouse)):
            if original_value == "off":
                continue
            if not pkg.set_tmux_session_option(session_name, option, "off", socket_name):  # type: ignore[union-attr]
                for changed_option, restore_value in reversed(changed_options):
                    pkg.set_tmux_session_option(session_name, changed_option, restore_value, socket_name)  # type: ignore[union-attr]
                return False
            changed_options.append((option, original_value))

        _EXTERNAL_ATTACH_STATES[state_key] = _ExternalAttachState(
            refcount=1,
            status=status,
            mouse=mouse,
            socket_name=socket_name,
        )
        logger.debug(
            "tmux_external_attach_applied",
            session=session_name,
            socket=socket_name,
            status=status,
            mouse=mouse,
        )
        return True


def restore_external_attach_options(session_name: str, socket_name: str | None = None) -> bool:
    """Restore external tmux UI after the last A-Term attachment ends."""
    pkg = _pkg()
    with _EXTERNAL_ATTACH_LOCK:
        state_key = f"{socket_name or 'default'}:{session_name}"
        existing = _EXTERNAL_ATTACH_STATES.get(state_key)
        if not existing:
            return True

        if existing.refcount > 1:
            existing.refcount -= 1
            logger.debug(
                "tmux_external_attach_released",
                session=session_name,
                socket=socket_name,
                refcount=existing.refcount,
            )
            return True

        success = True
        for option, original_value in (("mouse", existing.mouse), ("status", existing.status)):
            if original_value == "off":
                continue
            success = pkg.set_tmux_session_option(  # type: ignore[union-attr]
                session_name, option, original_value, socket_name
            ) and success

        _EXTERNAL_ATTACH_STATES.pop(state_key, None)
        if success:
            logger.debug("tmux_external_attach_restored", session=session_name, socket=socket_name)
        else:
            logger.warning(
                "tmux_external_attach_restore_failed",
                session=session_name,
                socket=socket_name,
            )
        return success
