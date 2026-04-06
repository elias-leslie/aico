"""A-Term Sessions API - REST endpoints for session management.

This module provides:
- List a_term sessions
- Update session metadata (name, order)
- Delete session (also kills tmux)

Sessions are global (not project-scoped) but may have a project_id
for context-aware working directory.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ..logging_config import get_logger
from ..rate_limit import limiter
from ..services import lifecycle
from ..services.session_close import close_session
from ..storage import sessions as a_term_store
from ..utils.tmux import get_external_agent_tmux_session, list_external_agent_tmux_sessions
from .validators import validate_uuid

logger = get_logger(__name__)

router = APIRouter(tags=["A-Term Sessions"])


# ============================================================================
# Request/Response Models
# ============================================================================


class ATermSessionResponse(BaseModel):
    """A-Term session response model."""

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    user_id: str | None
    project_id: str | None
    working_dir: str | None
    display_order: int
    mode: str
    session_number: int
    is_alive: bool
    created_at: str | None
    last_accessed_at: str | None
    claude_state: str | None = None  # not_started, starting, running, stopped, error
    tmux_session_name: str | None = None
    tmux_pane_id: str | None = None
    is_external: bool = False
    source: str | None = None


class ATermSessionListResponse(BaseModel):
    """Response for listing a_term sessions."""

    items: list[ATermSessionResponse]
    total: int


class UpdateSessionRequest(BaseModel):
    """Request to update a a_term session."""

    name: str | None = Field(default=None, max_length=255)
    display_order: int | None = None


# ============================================================================
# Endpoints
# ============================================================================


@router.get("/api/a-term/sessions", response_model=ATermSessionListResponse)
async def list_sessions() -> ATermSessionListResponse:
    """List all alive a_term sessions.

    Returns only sessions where is_alive=True.
    Sessions are ordered by display_order, then created_at.
    """
    sessions = a_term_store.list_sessions(include_dead=False, include_detached=False)
    external_sessions = list_external_agent_tmux_sessions()
    all_sessions = [*sessions, *external_sessions]

    return ATermSessionListResponse(
        items=[ATermSessionResponse.model_validate(s) for s in all_sessions],
        total=len(all_sessions),
    )


@router.get("/api/a-term/sessions/{session_id}", response_model=ATermSessionResponse)
async def get_session(session_id: str) -> ATermSessionResponse:
    """Get a single a_term session by ID."""
    external_session = get_external_agent_tmux_session(session_id)
    if external_session:
        return ATermSessionResponse.model_validate(external_session)

    validate_uuid(session_id)
    session = a_term_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found") from None

    return ATermSessionResponse.model_validate(session)


@router.patch("/api/a-term/sessions/{session_id}", response_model=ATermSessionResponse)
async def update_session(session_id: str, request: UpdateSessionRequest) -> ATermSessionResponse:
    """Update a_term session metadata.

    Can update: name, display_order
    """
    external_session = get_external_agent_tmux_session(session_id)
    if external_session:
        raise HTTPException(status_code=400, detail="External tmux sessions are read-only") from None

    validate_uuid(session_id)

    # Verify session exists
    existing = a_term_store.get_session(session_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found") from None

    # Build update fields
    update_fields: dict[str, Any] = {}
    if request.name is not None:
        update_fields["name"] = request.name
    if request.display_order is not None:
        update_fields["display_order"] = request.display_order

    if not update_fields:
        return ATermSessionResponse.model_validate(existing)

    session = a_term_store.update_session(session_id, **update_fields)
    if not session:
        logger.error("session_update_failed", session_id=session_id, fields=list(update_fields.keys()))
        raise HTTPException(status_code=500, detail="Failed to update session") from None

    return ATermSessionResponse.model_validate(session)


@router.delete("/api/a-term/sessions/{session_id}")
@limiter.limit("10/minute")
async def delete_session(request: Request, session_id: str) -> dict[str, Any]:
    """Delete a a_term session.

    Kills the tmux session and deletes the database record.
    Idempotent - returns success even if session didn't exist.
    """
    if not get_external_agent_tmux_session(session_id):
        validate_uuid(session_id)

    return close_session(session_id)


@router.post("/api/a-term/sessions/{session_id}/reset", response_model=ATermSessionResponse)
@limiter.limit("10/minute")
async def reset_session(request: Request, session_id: str) -> ATermSessionResponse:
    """Reset a a_term session.

    Deletes the session and creates a new one with the same parameters.
    Returns the new session data.
    """
    validate_uuid(session_id)

    new_session_id = lifecycle.reset_session(session_id)
    if not new_session_id:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found") from None

    session = a_term_store.get_session(new_session_id)
    if not session:
        raise HTTPException(status_code=500, detail="Session reset but not found") from None

    return ATermSessionResponse.model_validate(session)


@router.post("/api/a-term/reset-all")
@limiter.limit("5/minute")
async def reset_all_sessions(request: Request) -> dict[str, Any]:
    """Reset all a_term sessions.

    Resets every active session. Returns count of sessions reset.
    """
    count = lifecycle.reset_all_sessions()
    return {"reset_count": count}
