"""Translate Tether failures into A-Term HTTP errors."""

from __future__ import annotations

from fastapi import HTTPException

from ..tether import TetherError, TetherUnavailable

_DETAILS = {
    "not_found": (404, "Not found"),
    "stale_generation": (409, "The session changed since it was read; refresh and try again"),
    "identity_changed": (409, "The session changed since it was read; refresh and try again"),
    "busy": (409, "Another operation is running on this session; try again"),
    "blocked": (409, "Tether could not prove cleanup for this session; it was preserved"),
    "workload_unavailable": (409, "The session is not running"),
    "legacy_session": (409, "This session predates Tether and is attach-only"),
    "admission_denied": (409, "Tether refused to start another agent right now"),
    "outcome_uncertain": (409, "Tether could not confirm the result; refresh before retrying"),
    "linger_required": (503, "Tether refuses durable sessions until linger is enabled"),
    "unknown_tool": (400, "Unknown agent tool"),
    "unknown_project": (400, "Unknown project"),
    "invalid_command": (
        400,
        "Command must be plain words separated by spaces: no quotes, $, globs or redirections",
    ),
    "invalid_argv": (400, "Invalid command arguments"),
    "slug_conflict": (409, "That slug or alias is already used by another tool"),
    "slug_immutable": (400, "A tool's slug cannot change"),
    "default_tool": (409, "The default tool cannot be deleted; make another tool the default first"),
    "tool_in_use": (409, "A running session uses this tool"),
    "invalid_body": (400, "Invalid request"),
}

UNAVAILABLE_DETAIL = "Tether is not reachable; sessions keep running, but control is unavailable"


def to_http_error(error: Exception, *, not_found: str | None = None) -> HTTPException:
    """Map a Tether exception to an :class:`HTTPException` with a plain detail."""
    if isinstance(error, TetherUnavailable):
        return HTTPException(status_code=503, detail=UNAVAILABLE_DETAIL)
    if isinstance(error, TetherError):
        status, detail = _DETAILS.get(error.code, (502 if error.status >= 500 or error.status == 0 else error.status, f"Tether error: {error.code}"))
        if error.code == "not_found" and not_found:
            detail = not_found
        if error.code in {"blocked", "admission_denied"} and isinstance(error.body, dict):
            reason = error.body.get("reason")
            if isinstance(reason, str) and reason:
                detail = f"{detail} ({reason})"
        return HTTPException(status_code=status, detail=detail)
    return HTTPException(status_code=500, detail="Unexpected error")
