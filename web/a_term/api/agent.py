"""Agent integration API: agent state per session and explicit agent restart."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..constants import AgentState
from ..logging_config import get_logger
from ..services import agent_service, lifecycle, session_catalog
from ..services.tether_errors import to_http_error
from ..tether import TetherError, TetherUnavailable

router = APIRouter(tags=["Agent Integration"])
logger = get_logger(__name__)


class AgentStateResponse(BaseModel):
    """Agent state for a session."""

    session_id: str
    agent_state: AgentState
    claude_state: AgentState  # Deprecated compatibility alias


class StartAgentResponse(BaseModel):
    """Result of an explicit agent start."""

    session_id: str
    started: bool
    message: str
    agent_state: AgentState
    claude_state: AgentState  # Deprecated compatibility alias


@router.get("/api/a-term/sessions/{session_id}/agent-state", response_model=AgentStateResponse)
def get_agent_state_endpoint(session_id: str) -> AgentStateResponse:
    try:
        session = session_catalog.get_session(session_id)
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error) from None
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    state = agent_service.normalize_state(session.get("agent_state"))
    return AgentStateResponse(session_id=session_id, agent_state=state, claude_state=state)


@router.get(
    "/api/a-term/sessions/{session_id}/claude-state",
    response_model=AgentStateResponse,
    include_in_schema=False,
)
def get_claude_state_endpoint(session_id: str) -> AgentStateResponse:
    """Legacy alias."""
    return get_agent_state_endpoint(session_id)


@router.post("/api/a-term/sessions/{session_id}/start-agent", response_model=StartAgentResponse)
def start_agent(session_id: str) -> StartAgentResponse:
    """Restart the agent of a session whose workload is not running."""
    try:
        result = agent_service.start_agent(session_id)
    except lifecycle.LifecycleError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from None
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error, not_found=f"Session {session_id} not found") from None
    return StartAgentResponse(
        session_id=session_id,
        started=result.started,
        message=result.message,
        agent_state=result.state,
        claude_state=result.state,
    )


@router.post(
    "/api/a-term/sessions/{session_id}/start-claude",
    response_model=StartAgentResponse,
    include_in_schema=False,
)
def start_claude(session_id: str) -> StartAgentResponse:
    """Legacy alias."""
    return start_agent(session_id)
