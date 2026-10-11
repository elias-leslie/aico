"""Agent state for a session, read from Tether.

Tether launches the agent when it creates a session and verifies the
workload (status ``running``). Starting an agent again is an explicit respawn
of a session whose workload is not running; it is never automatic.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast

from ..constants import AgentState
from ..logging_config import get_logger
from . import lifecycle, session_catalog

logger = get_logger(__name__)

_STATES = {"not_started", "starting", "running", "stopped", "error"}


def normalize_state(value: object) -> AgentState:
    return cast(AgentState, value) if value in _STATES else "not_started"


@dataclass(frozen=True)
class StartResult:
    started: bool
    state: AgentState
    message: str


def start_agent(session_id: str) -> StartResult:
    """Respawn an agent session whose workload is not running.

    Raises :class:`lifecycle.LifecycleError` for unknown, shell, legacy, root
    and external sessions.
    """
    session = session_catalog.get_session(session_id)
    if session is None:
        raise lifecycle.LifecycleError(404, f"Session {session_id} not found")
    state = normalize_state(session.get("agent_state"))
    if session.get("source") == "tmux_external":
        return StartResult(False, state, "External tmux agent session is already running")
    if session.get("is_root"):
        return StartResult(False, state, "Root launch is owned by its retained request")
    if session.get("mode") == "shell":
        raise lifecycle.LifecycleError(400, "Session is in shell mode, not agent mode")
    if session.get("is_legacy"):
        raise lifecycle.LifecycleError(409, "This session predates Tether and is attach-only")
    if session.get("status") == "running":
        return StartResult(False, "running", "Agent is already running")
    if session.get("status") == "pending":
        return StartResult(False, "starting", "Agent is already starting")
    refreshed = lifecycle.reset_session(session_id)
    new_state = normalize_state(refreshed.get("agent_state"))
    logger.info("agent_respawned", session_id=session_id, status=refreshed.get("status"))
    return StartResult(True, new_state, "Agent restarted")
