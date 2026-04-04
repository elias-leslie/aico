"""Agent service layer: state management and process verification.

Generalized from claude_service.py to support any CLI agent tool.
Uses parameterized command and process_name instead of hardcoded constants.
"""

from __future__ import annotations

import asyncio
import contextlib
import subprocess
import time
from typing import cast

from ..constants import AgentState
from ..logging_config import get_logger
from ..storage import agent_tools as agent_tools_store
from ..storage import sessions as terminal_store
from ..utils.tmux import get_tmux_session_name
from . import lifecycle

logger = get_logger(__name__)

# Delay before verifying agent started (agents need time to initialize)
AGENT_STARTUP_VERIFY_DELAY_SECONDS = 3


def _is_agent_running_in_session_sync(tmux_session: str, process_name: str) -> bool:
    """Check if an agent is running in a tmux session (sync).

    Tmux pane metadata is a fast first pass, but interactive wrappers like
    Codex can still leave pane_current_command as ``bash``. When metadata does
    not mention the tool, inspect the pane TTY process list before concluding
    the agent is absent.
    """
    result = subprocess.run(
        ["tmux", "list-panes", "-t", tmux_session, "-F", "#{pane_tty} #{pane_current_command} #{pane_start_command}"],
        capture_output=True,
        text=True,
        timeout=10,
    )

    if result.returncode != 0:
        logger.warning(
            "tmux_list_panes_failed",
            tmux_session=tmux_session,
            stderr=result.stderr,
            returncode=result.returncode,
        )
        return False

    process_name_lower = process_name.lower()
    pane_ttys: list[str] = []

    for raw_line in result.stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        tty, *command_parts = line.split(None, 2)
        metadata = " ".join(command_parts).lower()
        if process_name_lower in metadata:
            return True
        if tty.startswith("/dev/"):
            pane_ttys.append(tty.removeprefix("/dev/"))

    for pane_tty in pane_ttys:
        tty_result = subprocess.run(
            ["ps", "-t", pane_tty, "-o", "comm=,args="],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if tty_result.returncode == 0 and process_name_lower in tty_result.stdout.lower():
            return True

    return False


async def is_agent_running(tmux_session: str, process_name: str) -> bool:
    """Check if an agent is running in a tmux session (async)."""
    return await asyncio.to_thread(_is_agent_running_in_session_sync, tmux_session, process_name)


async def background_verify_agent_start(
    session_id: str, tmux_session: str, process_name: str
) -> None:
    """Background task: verify agent started, then update DB state accordingly."""
    try:
        await asyncio.sleep(AGENT_STARTUP_VERIFY_DELAY_SECONDS)

        if await is_agent_running(tmux_session, process_name):
            updated = terminal_store.update_claude_state(
                session_id, "running", expected_state="starting"
            )
            if updated:
                logger.info("agent_verified_running", session_id=session_id, tmux_session=tmux_session)
            else:
                logger.info("agent_state_already_changed", session_id=session_id, tmux_session=tmux_session)
        else:
            updated = terminal_store.update_claude_state(session_id, "error", expected_state="starting")
            if updated:
                logger.warning("agent_start_failed", session_id=session_id, tmux_session=tmux_session)
    except Exception as e:
        logger.error(
            "background_verify_failed",
            session_id=session_id,
            tmux_session=tmux_session,
            error=str(e),
        )
        with contextlib.suppress(Exception):
            terminal_store.update_claude_state(session_id, "error", expected_state="starting")


async def send_agent_command(session_id: str, tmux_session: str, command: str) -> str | None:
    """Send an agent start command via tmux send-keys.

    Returns an error message string on failure, or None on success.
    """
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            ["tmux", "send-keys", "-t", tmux_session, command, "Enter"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired as e:
        terminal_store.update_claude_state(session_id, "error", expected_state="starting")
        logger.error("agent_send_keys_timeout", session_id=session_id, error=str(e))
        return f"tmux send-keys timed out: {e}"

    if result.returncode != 0:
        terminal_store.update_claude_state(session_id, "error", expected_state="starting")
        error_msg = str(result.stderr)
        logger.error("agent_send_keys_failed", session_id=session_id, error=error_msg)
        return error_msg

    return None


def send_agent_command_sync(session_id: str, tmux_session: str, command: str) -> str | None:
    """Send an agent start command via tmux send-keys (sync)."""
    try:
        result = subprocess.run(
            ["tmux", "send-keys", "-t", tmux_session, command, "Enter"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired as e:
        terminal_store.update_claude_state(session_id, "error", expected_state="starting")
        logger.error("agent_send_keys_timeout", session_id=session_id, error=str(e))
        return f"tmux send-keys timed out: {e}"

    if result.returncode != 0:
        terminal_store.update_claude_state(session_id, "error", expected_state="starting")
        logger.error("agent_send_keys_failed", session_id=session_id, error=result.stderr)
        return result.stderr

    return None


def atomically_set_starting(session_id: str, current_state: AgentState) -> AgentState | None:
    """Atomically transition session to 'starting' state.

    Returns the new conflicting state if the CAS failed, else None (success).
    """
    updated = terminal_store.update_claude_state(
        session_id, "starting", expected_state=current_state
    )
    if not updated:
        return cast(AgentState, terminal_store.get_claude_state(session_id) or "not_started")
    return None


def _get_agent_launch_spec(mode: str) -> tuple[str, str]:
    """Return the configured command and process name for an agent mode."""
    if mode == "shell":
        raise ValueError("Shell sessions do not have agent launch commands")

    tool = agent_tools_store.get_by_slug(mode)
    if tool:
        return tool["command"], tool["process_name"]

    default = agent_tools_store.get_default()
    if default:
        return default["command"], default["process_name"]

    raise ValueError(f"No enabled agent tool found for mode '{mode}'")


def ensure_agent_running_sync(session_id: str) -> bool:
    """Start an agent session synchronously if needed.

    Returns True only when this call successfully launches and verifies the
    agent process. Returns False when the agent was already running, startup
    fails, or the session is not an agent session.
    """
    session = terminal_store.get_session(session_id)
    if not session:
        raise ValueError(f"Session {session_id} not found")

    mode = str(session.get("mode") or "shell")
    if mode == "shell":
        return False

    command, process_name = _get_agent_launch_spec(mode)
    tmux_session = get_tmux_session_name(session_id)

    if not lifecycle.ensure_session_alive(session_id):
        terminal_store.update_claude_state(session_id, "error")
        logger.warning("agent_start_sync_session_unavailable", session_id=session_id, tmux_session=tmux_session)
        return False

    if _is_agent_running_in_session_sync(tmux_session, process_name):
        terminal_store.update_claude_state(session_id, "running")
        return False

    current_state = cast(AgentState, session.get("claude_state") or "not_started")
    if current_state == "running":
        terminal_store.update_claude_state(session_id, "not_started")
        current_state = "not_started"

    conflicting_state = atomically_set_starting(session_id, current_state)
    if conflicting_state in {"starting", "running"}:
        return False

    send_error = send_agent_command_sync(session_id, tmux_session, command)
    if send_error:
        return False

    time.sleep(AGENT_STARTUP_VERIFY_DELAY_SECONDS)
    if _is_agent_running_in_session_sync(tmux_session, process_name):
        terminal_store.update_claude_state(session_id, "running", expected_state="starting")
        return True

    terminal_store.update_claude_state(session_id, "error", expected_state="starting")
    logger.warning("agent_start_failed_sync", session_id=session_id, tmux_session=tmux_session)
    return False
