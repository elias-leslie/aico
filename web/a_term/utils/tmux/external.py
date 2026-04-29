"""External agent session discovery, option management, and attach state."""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from ...logging_config import get_logger
from .core import TMUX_COMMAND_TIMEOUT

logger = get_logger(__name__)

_EXTERNAL_AGENT_TOKENS = ("claude", "codex", "opencode", "aider", "gemini", "hermes", "pi")

_EXTERNAL_ATTACH_LOCK = Lock()
_EXTERNAL_ATTACH_STATES: dict[str, _ExternalAttachState] = {}


@dataclass
class _ExternalAttachState:
    refcount: int
    status: str
    mouse: str


def _pkg() -> object:
    """Return the a_term.utils.tmux package module (avoids circular import)."""
    return sys.modules["a_term.utils.tmux"]


def _infer_external_mode(session_name: str, current_command: str) -> tuple[str, str]:
    label = f"{session_name} {current_command}".lower()
    for token in _EXTERNAL_AGENT_TOKENS:
        if re.search(rf"(^|[^a-z0-9]){re.escape(token)}([^a-z0-9]|$)", label):
            return token, "running"
    return "shell", "not_started"


def _infer_project_id(working_dir: str | None) -> str | None:
    if not working_dir:
        return None
    try:
        root = subprocess.run(
            ["git", "-C", working_dir, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=TMUX_COMMAND_TIMEOUT,
            check=False,
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    if not root:
        return None
    return Path(root).name


def list_external_agent_tmux_sessions() -> list[dict[str, object]]:
    """List externally created tmux agent sessions that A-Term can attach to."""
    pkg = _pkg()
    success, output = pkg.run_tmux_command(  # type: ignore[union-attr]
        [
            "list-panes",
            "-a",
            "-F",
            "#{session_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}",
        ]
    )
    if not success:
        return []

    sessions: dict[str, dict[str, object]] = {}
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) != 4:
            continue
        session_name, pane_id, working_dir, current_command = parts
        if not session_name or pkg.is_managed_tmux_session_name(session_name):  # type: ignore[union-attr]
            continue
        mode, agent_state = _infer_external_mode(session_name, current_command)
        if mode == "shell":
            continue
        existing = sessions.get(session_name)
        if existing and existing.get("working_dir"):
            continue
        sessions[session_name] = {
            "id": session_name,
            "name": session_name,
            "user_id": None,
            "project_id": _infer_project_id(working_dir or None),
            "working_dir": working_dir or None,
            "display_order": 0,
            "mode": mode,
            "session_number": 0,
            "is_alive": True,
            "created_at": None,
            "last_accessed_at": None,
            "agent_state": agent_state,
            "claude_state": agent_state,
            "tmux_session_name": session_name,
            "tmux_pane_id": pane_id or None,
            "is_external": True,
            "source": "tmux_external",
        }
    return sorted(sessions.values(), key=lambda row: str(row.get("name") or ""))


def get_external_agent_tmux_session(session_ref: str) -> dict[str, object] | None:
    """Return one external tmux agent session by its synthetic id or tmux session name."""
    pkg = _pkg()
    for session in pkg.list_external_agent_tmux_sessions():  # type: ignore[union-attr]
        if session.get("id") == session_ref or session.get("tmux_session_name") == session_ref:
            return session
    return None


def _normalize_tmux_toggle(value: str) -> str | None:
    normalized = value.strip().lower()
    if normalized in {"on", "1", "yes"}:
        return "on"
    if normalized in {"off", "0", "no"}:
        return "off"
    return None


def get_tmux_session_option(session_name: str, option: str) -> str | None:
    """Return the effective session option value normalized to on/off."""
    pkg = _pkg()
    commands = (
        ["show-options", "-qv", "-t", session_name, option],
        ["show-options", "-gqv", option],
    )
    for args in commands:
        success, output = pkg.run_tmux_command(args)  # type: ignore[union-attr]
        if not success or not output.strip():
            continue
        normalized = _normalize_tmux_toggle(output)
        if normalized:
            return normalized

    logger.warning("tmux_option_read_failed", session=session_name, option=option)
    return None


def set_tmux_session_option(session_name: str, option: str, value: str) -> bool:
    """Set a tmux session option to a normalized on/off value."""
    pkg = _pkg()
    success, _ = pkg.run_tmux_command(["set-option", "-t", session_name, option, value])  # type: ignore[union-attr]
    if success:
        logger.debug("tmux_option_set", session=session_name, option=option, value=value)
    else:
        logger.warning("tmux_option_set_failed", session=session_name, option=option, value=value)
    return success


def apply_external_attach_options(session_name: str) -> bool:
    """Normalize external tmux UI while A-Term is attached."""
    pkg = _pkg()
    with _EXTERNAL_ATTACH_LOCK:
        existing = _EXTERNAL_ATTACH_STATES.get(session_name)
        if existing:
            existing.refcount += 1
            logger.debug(
                "tmux_external_attach_reused",
                session=session_name,
                refcount=existing.refcount,
            )
            return True

        status = pkg.get_tmux_session_option(session_name, "status")  # type: ignore[union-attr]
        mouse = pkg.get_tmux_session_option(session_name, "mouse")  # type: ignore[union-attr]
        if status is None or mouse is None:
            return False

        changed_options: list[tuple[str, str]] = []
        for option, original_value in (("status", status), ("mouse", mouse)):
            if original_value == "off":
                continue
            if not pkg.set_tmux_session_option(session_name, option, "off"):  # type: ignore[union-attr]
                for changed_option, restore_value in reversed(changed_options):
                    pkg.set_tmux_session_option(session_name, changed_option, restore_value)  # type: ignore[union-attr]
                return False
            changed_options.append((option, original_value))

        _EXTERNAL_ATTACH_STATES[session_name] = _ExternalAttachState(
            refcount=1,
            status=status,
            mouse=mouse,
        )
        logger.debug(
            "tmux_external_attach_applied",
            session=session_name,
            status=status,
            mouse=mouse,
        )
        return True


def restore_external_attach_options(session_name: str) -> bool:
    """Restore external tmux UI after the last A-Term attachment ends."""
    pkg = _pkg()
    with _EXTERNAL_ATTACH_LOCK:
        existing = _EXTERNAL_ATTACH_STATES.get(session_name)
        if not existing:
            return True

        if existing.refcount > 1:
            existing.refcount -= 1
            logger.debug(
                "tmux_external_attach_released",
                session=session_name,
                refcount=existing.refcount,
            )
            return True

        success = True
        for option, original_value in (("mouse", existing.mouse), ("status", existing.status)):
            if original_value == "off":
                continue
            success = pkg.set_tmux_session_option(session_name, option, original_value) and success  # type: ignore[union-attr]

        _EXTERNAL_ATTACH_STATES.pop(session_name, None)
        if success:
            logger.debug("tmux_external_attach_restored", session=session_name)
        else:
            logger.warning("tmux_external_attach_restore_failed", session=session_name)
        return success
