"""A-Term WebSocket API and internal maintenance endpoints.

- ``/ws/a-term/{session_id}`` attaches a view to a session (Tether, legacy or
  the user's own tmux session).
- ``/api/internal/maintenance*`` need the internal token.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request, WebSocket

from ..auth import UNAUTHORIZED_WS_CODE, authenticate_websocket
from ..services.maintenance import get_status as get_maintenance_status
from ..services.maintenance import list_recent_runs as list_recent_maintenance_runs
from ..services.maintenance import run_cycle as run_maintenance_cycle
from .handlers.internal_auth import require_internal_token
from .handlers.websocket_connection import handle_a_term_connection

router = APIRouter()


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
    """Return recent maintenance runs (kept in memory since startup)."""
    require_internal_token(request, token)
    runs = list_recent_maintenance_runs(request.app, limit=limit)
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
