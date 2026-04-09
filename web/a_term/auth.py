"""Public auth/session helpers for A-Term HTTP and WebSocket access."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from fastapi import HTTPException, Request, Response, WebSocket

from .config import get_settings

UNAUTHORIZED_DETAIL = "Authentication required"
UNAUTHORIZED_WS_CODE = 4401


@dataclass(frozen=True)
class AuthSettings:
    mode: Literal["none", "password", "proxy"]
    password: str
    secret: str
    proxy_header: str
    cookie_name: str
    cookie_secure: bool
    session_ttl_seconds: int


@dataclass(frozen=True)
class AuthSession:
    identity: str
    mode: Literal["none", "password", "proxy"]
    expires_at: int


def get_auth_settings() -> AuthSettings:
    """Return the current auth configuration."""
    settings = get_settings()
    return AuthSettings(
        mode=settings.a_term_auth_mode,
        password=settings.a_term_auth_password,
        secret=settings.a_term_auth_secret,
        proxy_header=settings.a_term_auth_proxy_header,
        cookie_name=settings.a_term_auth_cookie_name,
        cookie_secure=settings.a_term_auth_cookie_secure,
        session_ttl_seconds=settings.a_term_auth_session_ttl_hours * 3600,
    )


def is_auth_enabled() -> bool:
    """Return whether public auth is required."""
    return get_auth_settings().mode != "none"


def _urlsafe_b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _urlsafe_b64decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _sign(data: str, secret: str) -> str:
    return _urlsafe_b64encode(
        hmac.new(secret.encode(), data.encode(), hashlib.sha256).digest()
    )


def _build_session(identity: str, mode: Literal["password", "proxy"]) -> AuthSession:
    settings = get_auth_settings()
    return AuthSession(
        identity=identity,
        mode=mode,
        expires_at=int(time.time()) + settings.session_ttl_seconds,
    )


def create_password_session() -> AuthSession:
    """Build a new password-auth session."""
    return _build_session("owner", "password")


def create_proxy_session(identity: str) -> AuthSession:
    """Build a new proxy-auth session for the forwarded identity."""
    return _build_session(identity, "proxy")


def encode_session(session: AuthSession) -> str:
    """Serialize and sign a public auth session."""
    settings = get_auth_settings()
    payload = json.dumps(
        {
            "identity": session.identity,
            "mode": session.mode,
            "expires_at": session.expires_at,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return f"{_urlsafe_b64encode(payload.encode())}.{_sign(payload, settings.secret)}"


def decode_session(token: str | None) -> AuthSession | None:
    """Verify and decode a signed session cookie."""
    if not token:
        return None
    settings = get_auth_settings()
    try:
        encoded_payload, encoded_signature = token.split(".", 1)
        payload = _urlsafe_b64decode(encoded_payload).decode()
    except (ValueError, UnicodeDecodeError):
        return None

    expected_signature = _sign(payload, settings.secret)
    if not hmac.compare_digest(encoded_signature, expected_signature):
        return None

    try:
        data = json.loads(payload)
        session = AuthSession(
            identity=str(data["identity"]),
            mode=data["mode"],
            expires_at=int(data["expires_at"]),
        )
    except (KeyError, TypeError, ValueError):
        return None

    if session.mode != settings.mode:
        return None
    if session.expires_at <= int(time.time()):
        return None
    return session


def _get_header(headers: Mapping[str, str], name: str) -> str | None:
    return headers.get(name)


def get_proxy_identity(headers: Mapping[str, str]) -> str | None:
    """Extract a trusted upstream identity when proxy auth is enabled."""
    settings = get_auth_settings()
    if settings.mode != "proxy":
        return None
    value = _get_header(headers, settings.proxy_header)
    if value is None:
        return None
    identity = value.strip()
    return identity or None


def authenticate_request(request: Request) -> AuthSession | None:
    """Authenticate an HTTP request from cookie or trusted proxy headers."""
    settings = get_auth_settings()
    if settings.mode == "none":
        return AuthSession(identity="local", mode="none", expires_at=2**31)

    session = decode_session(request.cookies.get(settings.cookie_name))
    if session is not None:
        return session

    identity = get_proxy_identity(request.headers)
    if identity is not None:
        return create_proxy_session(identity)
    return None


def authenticate_websocket(websocket: WebSocket) -> AuthSession | None:
    """Authenticate a WebSocket handshake from cookie or trusted proxy headers."""
    settings = get_auth_settings()
    if settings.mode == "none":
        return AuthSession(identity="local", mode="none", expires_at=2**31)

    session = decode_session(websocket.cookies.get(settings.cookie_name))
    if session is not None:
        return session

    identity = get_proxy_identity(websocket.headers)
    if identity is not None:
        return create_proxy_session(identity)
    return None


def require_request_auth(request: Request) -> AuthSession:
    """Raise 401 when a request is not authenticated."""
    session = authenticate_request(request)
    if session is None:
        raise HTTPException(status_code=401, detail=UNAUTHORIZED_DETAIL)
    return session


def verify_password(password: str) -> bool:
    """Return whether a submitted password matches the configured secret."""
    settings = get_auth_settings()
    if settings.mode != "password" or not settings.password:
        return False
    return hmac.compare_digest(password, settings.password)


def set_session_cookie(response: Response, session: AuthSession) -> None:
    """Attach the signed session cookie to a response."""
    settings = get_auth_settings()
    response.set_cookie(
        settings.cookie_name,
        encode_session(session),
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        max_age=settings.session_ttl_seconds,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    """Clear the auth session cookie."""
    response.delete_cookie(get_auth_settings().cookie_name, path="/")
