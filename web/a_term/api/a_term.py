"""A-Term WebSocket API: ``/ws/a-term/{session_id}`` attaches a view to a session.

The session is a Tether session or the user's own tmux session.
"""

from __future__ import annotations

from fastapi import APIRouter, WebSocket

from ..auth import UNAUTHORIZED_WS_CODE, authenticate_websocket
from ..config import settings
from .handlers.websocket_connection import handle_a_term_connection

router = APIRouter()


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
    origin = websocket.headers.get("origin")
    if origin is not None and origin not in settings.a_term_allowed_origins:
        await websocket.close(code=1008, reason="Origin not allowed")
        return
    if authenticate_websocket(websocket) is None:
        await websocket.close(code=UNAUTHORIZED_WS_CODE, reason="Authentication required")
        return
    await handle_a_term_connection(websocket, session_id)
