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
from .session_capabilities import SessionFacts, refusal

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

    Own tmux and root sessions are never respawned here: the capability table
    declines them, and they return a ``StartResult`` with ``started=False`` and
    their current state. Raises :class:`lifecycle.LifecycleError` for unknown
    sessions and for the refusals the table raises (shell sessions, and sessions
    an older Tether made, which are attach-only).
    """
    session = session_catalog.get_session(session_id)
    if session is None:
        raise lifecycle.LifecycleError(404, f"Session {session_id} not found")
    state = normalize_state(session["agent_state"])
    refused = refusal("start_agent", SessionFacts.of(session))
    if refused is not None:
        if refused.status is None:
            return StartResult(False, state, refused.detail)
        raise refused.error()
    if session.get("status") == "running":
        return StartResult(False, "running", "Agent is already running")
    if session.get("status") == "pending":
        return StartResult(False, "starting", "Agent is already starting")
    refreshed = lifecycle.reset_session(session_id)
    new_state = normalize_state(refreshed.get("agent_state"))
    logger.info("agent_respawned", session_id=session_id, status=refreshed.get("status"))
    return StartResult(True, new_state, "Agent restarted")
