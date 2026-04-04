"""Session switch hook handler."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from ...logging_config import get_logger
from ...storage import sessions as terminal_store
from ...utils.tmux import TMUX_SESSION_PREFIX as BASE_SESSION_PREFIX
from ...utils.tmux import validate_session_name
from .internal_auth import extract_internal_token, verify_internal_token

logger = get_logger(__name__)

# Status and reason constants
STATUS_REJECTED = "rejected"
STATUS_IGNORED = "ignored"
STATUS_CLEARED = "cleared"
STATUS_STORED = "stored"

REASON_UNAUTHORIZED = "unauthorized"
REASON_INVALID_SESSION_NAME = "invalid session name"
REASON_NOT_FROM_BASE = "not from base session"

# Log event name constants
LOG_SWITCH_REJECTED = "session_switch_rejected"
LOG_SWITCH_TO_BASE = "session_switch_to_base"
LOG_SWITCH_DETECTED = "session_switch_detected"
LOG_INVALID_SESSION_ID = "invalid_session_id"

# Error messages
ERROR_INVALID_SESSION_ID = "Invalid session ID format"


def _validate_session_names(from_session: str, to_session: str) -> bool:
    """Validate that session names are safe.

    Empty from_session is valid (first connection to a session).
    Returns True if both names are valid, False otherwise.
    """
    if from_session and not validate_session_name(from_session):
        return False
    return bool(validate_session_name(to_session))


def _track_session_switch(terminal_session_id: str, to_session: str) -> dict[str, Any]:
    """Update stored session target for the given terminal session.

    Clears the target if switching back to a base session,
    otherwise stores the new target session name.
    """
    if to_session.startswith(BASE_SESSION_PREFIX):
        logger.info(LOG_SWITCH_TO_BASE, terminal=terminal_session_id)
        terminal_store.update_claude_session(terminal_session_id, None)
        return {"status": STATUS_CLEARED}

    logger.info(LOG_SWITCH_DETECTED, terminal=terminal_session_id, target=to_session)
    terminal_store.update_claude_session(terminal_session_id, to_session)
    return {"status": STATUS_STORED, "target": to_session}


def _reject_unauthorized(client_host: str | None) -> JSONResponse:
    """Return a 403 response for unauthorized requests."""
    logger.warning(LOG_SWITCH_REJECTED, reason="invalid_token", client=client_host)
    return JSONResponse(
        status_code=403,
        content={"status": STATUS_REJECTED, "reason": REASON_UNAUTHORIZED},
    )


def _reject_invalid_session_names(
    from_session: str, to_session: str
) -> JSONResponse:
    """Return a 400 response for invalid session names."""
    logger.warning(
        LOG_SWITCH_REJECTED,
        reason="invalid_session_name",
        from_session=from_session[:50] if from_session else "",
        to_session=to_session[:50],
    )
    return JSONResponse(
        status_code=400,
        content={"status": STATUS_REJECTED, "reason": REASON_INVALID_SESSION_NAME},
    )


def _extract_terminal_session_id(
    from_session: str,
) -> tuple[str, JSONResponse | None]:
    """Extract and validate the terminal session UUID from the base session name.

    Returns a tuple of (session_id, error_response).
    If extraction succeeds, error_response is None.
    If extraction fails, session_id is empty and error_response holds a 400 JSONResponse.
    """
    terminal_session_id = from_session[len(BASE_SESSION_PREFIX):]
    try:
        uuid.UUID(terminal_session_id)
    except ValueError:
        logger.warning(LOG_INVALID_SESSION_ID, raw=terminal_session_id)
        return "", JSONResponse(
            status_code=400,
            content={"error": ERROR_INVALID_SESSION_ID},
        )
    return terminal_session_id, None


def handle_session_switch(
    request: Request,
    from_session: str,
    to_session: str,
    token: str = "",
) -> dict[str, Any] | JSONResponse:
    """Handle tmux session switch notifications.

    Called by tmux hook when a client switches sessions.
    Extracts terminal session ID from the base session name and stores the target.

    Security: Verifies internal token generated at startup.

    Args:
        request: FastAPI request object
        from_session: Session switching from
        to_session: Session switching to
        token: Internal authentication token

    Returns:
        Status dict indicating action taken
    """
    client_host = request.client.host if request.client else None

    resolved_token = extract_internal_token(request, token)
    if not verify_internal_token(request, resolved_token):
        return _reject_unauthorized(client_host)

    if not _validate_session_names(from_session, to_session):
        return _reject_invalid_session_names(from_session, to_session)

    # Only track switches FROM a terminal base session
    # Empty from_session means initial connection, not a switch
    if not from_session or not from_session.startswith(BASE_SESSION_PREFIX):
        return {"status": STATUS_IGNORED, "reason": REASON_NOT_FROM_BASE}

    terminal_session_id, error = _extract_terminal_session_id(from_session)
    if error is not None:
        return error

    return _track_session_switch(terminal_session_id, to_session)
