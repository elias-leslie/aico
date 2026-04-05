"""Agent integration API.

Generalized from claude.py to support any CLI agent tool.

Provides:
- Get agent state for a aterm session (state machine based)
- Start an agent in a aterm session with state machine
- Legacy aliases for backward compatibility (claude-state, start-claude)
"""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from ..constants import AgentState
from ..logging_config import get_logger
from ..services import lifecycle
from ..services.agent_service import (
    atomically_set_starting,
    background_verify_agent_start,
    is_agent_running,
    send_agent_command,
)
from ..storage import agent_tools as agent_tools_store
from ..storage import sessions as aterm_store
from ..utils.tmux import (
    get_external_agent_tmux_session,
    get_tmux_session_name,
)

router = APIRouter(tags=["Agent Integration"])
logger = get_logger(__name__)


# ============================================================================
# Request/Response Models
# ============================================================================


class AgentStateResponse(BaseModel):
    """Agent state for a aterm session (state machine based)."""
    session_id: str
    claude_state: AgentState  # Keep field name for backward compat


class StartAgentResponse(BaseModel):
    """Response after starting an agent."""
    session_id: str
    started: bool
    message: str
    claude_state: AgentState  # Keep field name for backward compat


# ============================================================================
# Helpers
# ============================================================================


def _get_agent_tool_for_session(session: dict) -> tuple[str, str]:
    """Get command and process_name for a session's agent tool.

    Returns (command, process_name) from the agent_tools table,
    falling back to the default agent tool if the slug is not found.
    """
    mode = session.get("mode", "shell")
    if mode == "shell":
        raise HTTPException(status_code=400, detail="Session is in shell mode, not agent mode")

    tool = agent_tools_store.get_by_slug(mode)
    if tool:
        return tool["command"], tool["process_name"]

    # Fallback to default tool
    default = agent_tools_store.get_default()
    if default:
        return default["command"], default["process_name"]

    raise HTTPException(status_code=400, detail=f"No agent tool found for mode '{mode}'") from None


def _early_return(session_id: str, state: AgentState, msg: str) -> StartAgentResponse:
    return StartAgentResponse(session_id=session_id, started=False, message=msg, claude_state=state)


def _normalize_agent_state(value: object) -> AgentState:
    if value in {"not_started", "starting", "running", "stopped", "error"}:
        return cast(AgentState, value)
    return "not_started"


# ============================================================================
# Endpoints
# ============================================================================


@router.get(
    "/api/aterm/sessions/{session_id}/agent-state",
    response_model=AgentStateResponse,
)
async def get_agent_state_endpoint(session_id: str) -> AgentStateResponse:
    """Get agent state for a aterm session."""
    external_session = get_external_agent_tmux_session(session_id)
    if external_session:
        claude_state = _normalize_agent_state(external_session.get("claude_state", "not_started"))
        return AgentStateResponse(session_id=session_id, claude_state=claude_state)

    session = aterm_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found") from None

    claude_state = _normalize_agent_state(session.get("claude_state", "not_started"))
    return AgentStateResponse(session_id=session_id, claude_state=claude_state)


# Legacy alias
@router.get(
    "/api/aterm/sessions/{session_id}/claude-state",
    response_model=AgentStateResponse,
    include_in_schema=False,
)
async def get_claude_state_endpoint(session_id: str) -> AgentStateResponse:
    """Legacy alias: Get agent state for a aterm session."""
    return await get_agent_state_endpoint(session_id)


@router.post(
    "/api/aterm/sessions/{session_id}/start-agent",
    response_model=StartAgentResponse,
)
async def start_agent(session_id: str, background_tasks: BackgroundTasks) -> StartAgentResponse:
    """Start an agent in a aterm session using state-machine guards.

    Looks up the agent tool from the session's mode → agent_tools table
    to get the command and process_name.
    """
    external = get_external_agent_tmux_session(session_id)
    if external:
        return _early_return(
            session_id,
            _normalize_agent_state(external.get("claude_state", "running")),
            "External tmux agent session is already running",
        )

    session = aterm_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found") from None

    command, process_name = _get_agent_tool_for_session(session)
    current_state: AgentState = _normalize_agent_state(session.get("claude_state", "not_started"))

    if current_state == "starting":
        return _early_return(session_id, "starting", "Agent is already starting")
    if current_state == "running":
        return _early_return(session_id, "running", "Agent is already running")

    tmux_session = get_tmux_session_name(session_id)
    if not lifecycle.ensure_session_alive(session_id):
        raise HTTPException(status_code=400, detail=f"tmux session {tmux_session} does not exist") from None

    # Sync state if agent is already running but DB is stale
    if await is_agent_running(tmux_session, process_name):
        aterm_store.update_claude_state(session_id, "running", expected_state=current_state)
        return _early_return(session_id, "running", "Agent is already running in this session")

    # Atomically claim 'starting' (handles concurrent requests)
    conflicting_state = atomically_set_starting(session_id, current_state)
    if conflicting_state is not None:
        return _early_return(session_id, conflicting_state, f"Agent state changed to {conflicting_state}")

    send_error = await send_agent_command(session_id, tmux_session, command)
    if send_error:
        return _early_return(session_id, "error", f"Failed to send command: {send_error}")

    background_tasks.add_task(background_verify_agent_start, session_id, tmux_session, process_name)
    logger.info("agent_start_initiated", session_id=session_id, tmux_session=tmux_session)
    return StartAgentResponse(
        session_id=session_id, started=True,
        message="Agent command sent, verifying startup...", claude_state="starting",
    )


# Legacy alias
@router.post(
    "/api/aterm/sessions/{session_id}/start-claude",
    response_model=StartAgentResponse,
    include_in_schema=False,
)
async def start_claude(session_id: str, background_tasks: BackgroundTasks) -> StartAgentResponse:
    """Legacy alias: Start agent in a aterm session."""
    return await start_agent(session_id, background_tasks)
