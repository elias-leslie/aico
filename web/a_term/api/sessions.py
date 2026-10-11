"""A-Term Sessions API.

Lists every session A-Term can show (Tether's catalog, legacy default-server
A-Term sessions, and the user's own default-server agent sessions), renames
Tether sessions, ends sessions and respawns their workloads. Tether owns the
sessions; A-Term only keeps which pane shows each one.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..logging_config import get_logger
from ..rate_limit import limiter
from ..services import lifecycle, session_catalog
from ..services.session_close import close_session
from ..services.tether_errors import to_http_error
from ..storage import panes as pane_store
from ..tether import TetherError, TetherUnavailable, get_client

logger = get_logger(__name__)

router = APIRouter(tags=["A-Term Sessions"])


class ATermSessionResponse(BaseModel):
    """A-Term session response model."""

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    user_id: str | None = None
    project_id: str | None = None
    working_dir: str | None = None
    display_order: int = 0
    mode: str
    session_number: int = 1
    is_alive: bool = True
    created_at: str | None = None
    last_accessed_at: str | None = None
    agent_state: str | None = None
    claude_state: str | None = None
    tmux_session_name: str | None = None
    tmux_session_id: str | None = None
    tmux_pane_id: str | None = None
    tmux_socket: str | None = None
    tmux_source: str | None = None
    tmux_source_label: str | None = None
    is_external: bool = False
    is_root: bool = False
    is_legacy: bool = False
    source: str | None = None
    origin: str | None = None
    status: str | None = None
    generation: str | None = None
    pane_id: str | None = None

    @model_validator(mode="before")
    @classmethod
    def populate_agent_state(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values
        agent_state = values.get("agent_state") or values.get("claude_state") or "not_started"
        return {**values, "agent_state": agent_state, "claude_state": values.get("claude_state") or agent_state}


class ATermSessionListResponse(BaseModel):
    items: list[ATermSessionResponse]
    total: int


class UpdateSessionRequest(BaseModel):
    name: str | None = Field(default=None, max_length=160)
    display_order: int | None = None


def _get_or_404(session_id: str) -> dict[str, Any]:
    try:
        session = session_catalog.get_session(session_id)
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error) from None
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    return session


@router.get("/api/a-term/sessions", response_model=ATermSessionListResponse)
def list_sessions(include_detached: bool = False) -> ATermSessionListResponse:
    """List live sessions. Sessions shown by a detached pane are hidden unless asked for."""
    sessions = session_catalog.list_sessions()
    if not include_detached:
        detached = {pane["id"] for pane in pane_store.list_panes(include_detached=True) if pane["is_detached"]}
        sessions = [session for session in sessions if session.get("pane_id") not in detached]
    return ATermSessionListResponse(
        items=[ATermSessionResponse.model_validate(session) for session in sessions],
        total=len(sessions),
    )


@router.get("/api/a-term/sessions/{session_id}", response_model=ATermSessionResponse)
def get_session(session_id: str) -> ATermSessionResponse:
    return ATermSessionResponse.model_validate(_get_or_404(session_id))


@router.patch("/api/a-term/sessions/{session_id}", response_model=ATermSessionResponse)
def update_session(session_id: str, request: UpdateSessionRequest) -> ATermSessionResponse:
    """Rename a Tether session (in Tether, visible in Aico too) or reorder its view."""
    session = _get_or_404(session_id)
    if session.get("source") != "tether":
        raise HTTPException(status_code=400, detail="Only Tether sessions can be renamed")
    if request.display_order is not None and session.get("pane_id"):
        pane_store.update_link(session_id, display_order=request.display_order)
    if request.name is not None:
        name = request.name.strip() or None
        try:
            get_client().rename_session(session_id, str(session.get("generation")), name)
        except (TetherError, TetherUnavailable) as error:
            raise to_http_error(error, not_found=f"Session {session_id} not found") from None
    return ATermSessionResponse.model_validate(_get_or_404(session_id))


@router.delete("/api/a-term/sessions/{session_id}")
@limiter.limit("10/minute")
def delete_session(request: Request, session_id: str) -> dict[str, Any]:
    """End a session in Tether. Idempotent: an already-ended session reports success."""
    try:
        return close_session(session_id)
    except lifecycle.LifecycleError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from None
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error) from None


@router.post("/api/a-term/sessions/{session_id}/reset", response_model=ATermSessionResponse)
@limiter.limit("10/minute")
def reset_session(request: Request, session_id: str) -> ATermSessionResponse:
    """Respawn the session's workload: same session and tool, new generation."""
    try:
        return ATermSessionResponse.model_validate(lifecycle.reset_session(session_id))
    except lifecycle.LifecycleError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from None
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error, not_found=f"Session {session_id} not found") from None


@router.post("/api/a-term/reset-all")
@limiter.limit("5/minute")
def reset_all_sessions(request: Request) -> dict[str, Any]:
    """Respawn every Tether session A-Term panes show."""
    try:
        return {"reset_count": lifecycle.reset_all_sessions()}
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error) from None
