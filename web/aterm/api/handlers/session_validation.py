"""Session validation and preparation logic."""

from __future__ import annotations

from typing import Any

from ...logging_config import get_logger
from ...services import lifecycle
from ...storage import sessions as aterm_store
from ...utils.tmux import get_external_agent_tmux_session, get_tmux_session_name

logger = get_logger(__name__)


def validate_and_prepare_session(session_id: str) -> tuple[dict[str, Any], str]:
    """Validate session exists and prepare for WebSocket connection.

    Args:
        session_id: A-Term session identifier

    Returns:
        Tuple of (session_dict, tmux_session_name)

    Raises:
        ValueError: If session is invalid or cannot be restored
    """
    external_session = get_external_agent_tmux_session(session_id)
    if external_session is not None:
        return external_session, str(external_session.get("tmux_session_name") or session_id)

    # Check if session exists in DB and ensure tmux is alive
    # This will recreate tmux if the DB record exists but tmux died
    try:
        is_alive = lifecycle.ensure_session_alive(session_id)
    except Exception as e:
        # Handle invalid session IDs (e.g., non-UUID format)
        logger.warning("aterm_session_invalid", session_id=session_id, error=str(e))
        raise ValueError(f"Invalid session ID: {session_id}") from e

    if not is_alive:
        # Session doesn't exist in DB or couldn't be resurrected
        logger.warning("aterm_session_dead", session_id=session_id)
        raise ValueError(f"Session not found or could not be restored: {session_id}")

    # Touch session to update last_accessed_at
    aterm_store.touch_session(session_id)

    # Get session info for working directory and stored target session
    session = aterm_store.get_session(session_id)
    if not session:
        raise ValueError(f"Session not found after validation: {session_id}")

    tmux_session_name = get_tmux_session_name(session_id)

    return session, tmux_session_name
