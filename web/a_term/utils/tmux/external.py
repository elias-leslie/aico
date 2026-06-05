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


@dataclass(frozen=True)
class ExternalTmuxSource:
    """A tmux server that can contribute attachable external sessions."""

    id: str
    label: str
    socket_name: str | None = None
    session_prefix: str | None = None
    include_shell: bool = False

    def external_id(self, session_name: str) -> str:
        if self.socket_name is None:
            return session_name
        return f"tmux:{self.id}:{session_name}"


@dataclass
class _ExternalAttachState:
    refcount: int
    status: str
    mouse: str
    socket_name: str | None = None


_EXTERNAL_TMUX_SOURCES = (
    ExternalTmuxSource(id="default", label="tmux"),
    ExternalTmuxSource(
        id="aico",
        label="Aico",
        socket_name="aico",
        session_prefix="aico-",
        include_shell=True,
    ),
)


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


def _session_matches_source(source: ExternalTmuxSource, session_name: str) -> bool:
    pkg = _pkg()
    if not pkg.validate_session_name(session_name):  # type: ignore[union-attr]
        return False
    if source.session_prefix and not session_name.startswith(source.session_prefix):
        return False
    return not (
        source.socket_name is None
        and pkg.is_managed_tmux_session_name(session_name)  # type: ignore[union-attr]
    )


def list_external_tmux_sessions() -> list[dict[str, object]]:
    """List externally created tmux sessions that A-Term can attach to."""
    pkg = _pkg()
    sessions: dict[str, dict[str, object]] = {}
    for source in _EXTERNAL_TMUX_SOURCES:
        list_args = [
            "list-panes",
            "-a",
            "-F",
            "#{session_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}",
        ]
        if source.socket_name:
            success, output = pkg.run_tmux_command(  # type: ignore[union-attr]
                list_args,
                socket_name=source.socket_name,
            )
        else:
            success, output = pkg.run_tmux_command(list_args)  # type: ignore[union-attr]
        if not success:
            continue

        for line in output.splitlines():
            parts = line.split("\t")
            if len(parts) != 4:
                continue
            session_name, pane_id, working_dir, current_command = parts
            if not session_name or not _session_matches_source(source, session_name):
                continue
            mode, agent_state = _infer_external_mode(session_name, current_command)
            if mode == "shell" and not source.include_shell:
                continue
            external_id = source.external_id(session_name)
            existing = sessions.get(external_id)
            if existing and existing.get("working_dir"):
                continue
            sessions[external_id] = {
                "id": external_id,
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
                "tmux_socket": source.socket_name,
                "tmux_source": source.id,
                "tmux_source_label": source.label,
                "is_external": True,
                "source": "tmux_external",
            }
    return sorted(sessions.values(), key=lambda row: str(row.get("name") or ""))


def list_external_agent_tmux_sessions() -> list[dict[str, object]]:
    """Compatibility alias for the original external-session discovery API."""
    return list_external_tmux_sessions()


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
