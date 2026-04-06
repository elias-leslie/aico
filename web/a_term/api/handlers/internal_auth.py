"""Shared internal-token helpers for localhost-only endpoints."""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request

APP_STATE_TOKEN_ATTR = "internal_token"


def extract_internal_token(request: Request, query_token: str = "") -> str:
    """Extract the internal auth token from Authorization or query string."""
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:]
    return query_token


def verify_internal_token(request: Request, token: str) -> bool:
    """Verify a request token against the in-memory app token."""
    expected_token = (
        request.app.state.internal_token
        if hasattr(request.app.state, APP_STATE_TOKEN_ATTR)
        else ""
    )
    return bool(expected_token) and hmac.compare_digest(token, expected_token)


def require_internal_token(request: Request, query_token: str = "") -> None:
    """Raise 403 unless the request presents the current internal token."""
    token = extract_internal_token(request, query_token)
    if verify_internal_token(request, token):
        return
    raise HTTPException(status_code=403, detail="Unauthorized") from None
