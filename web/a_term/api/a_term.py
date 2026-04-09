"""A-Term WebSocket API for PTY sessions.

Provides WebSocket endpoints for a_term access:
- /ws/a-term/{session_id} - Connect to a a_term session

Uses tmux for session persistence so a_term sessions survive disconnects.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request, WebSocket
from fastapi.responses import JSONResponse

from ..auth import UNAUTHORIZED_WS_CODE, authenticate_websocket
from ..services.maintenance import get_status as get_maintenance_status
from ..services.maintenance import run_cycle as run_maintenance_cycle
from ..storage.maintenance_runs import list_recent_runs as list_recent_maintenance_runs
from .handlers.internal_auth import require_internal_token
from .handlers.session_switch import handle_session_switch
from .handlers.websocket_connection import handle_a_term_connection

router = APIRouter()


@router.get("/api/internal/session-switch", response_model=None)
async def session_switch_hook(
    request: Request,
    from_session: str = Query(..., alias="from"),
    to_session: str = Query(..., alias="to"),
    token: str = Query(""),
) -> dict[str, Any] | JSONResponse:
    """Handle tmux session switch notifications.

    Called by tmux hook when a client switches sessions.
    Extracts a_term session ID from the base session name and stores the target.

    Security: Only accepts requests from localhost (tmux hooks).
    """
    return handle_session_switch(request, from_session, to_session, token)


@router.get("/api/internal/maintenance", response_model=None)
async def maintenance_status(request: Request, token: str = Query("")) -> dict[str, Any]:
    """Return current maintenance status for operational verification."""
    require_internal_token(request, token)
    return get_maintenance_status(request.app)


@router.post("/api/internal/maintenance/run", response_model=None)
async def run_maintenance(request: Request, token: str = Query("")) -> dict[str, Any]:
    """Trigger one immediate maintenance cycle."""
    require_internal_token(request, token)
    return await run_maintenance_cycle(request.app, reason="manual")


@router.get("/api/internal/maintenance/runs", response_model=None)
async def maintenance_runs(
    request: Request,
    token: str = Query(""),
    limit: int = Query(10, ge=1, le=100),
) -> dict[str, Any]:
    """Return recent persisted maintenance runs."""
    require_internal_token(request, token)
    runs = list_recent_maintenance_runs(limit=limit)
    return {"items": runs, "total": len(runs)}


@router.websocket("/ws/a-term/{session_id}")
async def a_term_websocket(
    websocket: WebSocket,
    session_id: str,
) -> None:
    """WebSocket endpoint for a_term sessions.

    Protocol:
    - Text messages: Input to a_term
    - Binary messages starting with 'r': Resize event (JSON: {cols, rows})
    - Server sends output as text messages

    Args:
        websocket: WebSocket connection
        session_id: A-Term session identifier
    """
    if authenticate_websocket(websocket) is None:
        await websocket.close(code=UNAUTHORIZED_WS_CODE, reason="Authentication required")
        return
    await handle_a_term_connection(websocket, session_id)
