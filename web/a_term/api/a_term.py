"""A-Term WebSocket API: ``/ws/a-term/{session_id}`` attaches a view to a session.

The session is a Tether session or the user's own tmux session. Who may connect (Origin, then auth) is decided
before this endpoint runs, by the route's ``browser`` surface (``a_term.caller_trust``).
"""

from __future__ import annotations

from fastapi import APIRouter, WebSocket

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
    await handle_a_term_connection(websocket, session_id)
