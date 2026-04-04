"""Terminal WebSocket API for PTY sessions.

Provides WebSocket endpoints for terminal access:
- /ws/terminal/{session_id} - Connect to a terminal session

Uses tmux for session persistence so terminals survive disconnects.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request, WebSocket
from fastapi.responses import JSONResponse

from ..services.maintenance import get_status as get_maintenance_status
from ..services.maintenance import run_cycle as run_maintenance_cycle
from ..storage.maintenance_runs import list_recent_runs as list_recent_maintenance_runs
from .handlers.internal_auth import require_internal_token
from .handlers.session_switch import handle_session_switch
from .handlers.websocket_connection import handle_terminal_connection

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
    Extracts terminal session ID from the base session name and stores the target.

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


@router.websocket("/ws/terminal/{session_id}")
async def terminal_websocket(
    websocket: WebSocket,
    session_id: str,
) -> None:
    """WebSocket endpoint for terminal sessions.

    Protocol:
    - Text messages: Input to terminal
    - Binary messages starting with 'r': Resize event (JSON: {cols, rows})
    - Server sends output as text messages

    Args:
        websocket: WebSocket connection
        session_id: Terminal session identifier
    """
    await handle_terminal_connection(websocket, session_id)
