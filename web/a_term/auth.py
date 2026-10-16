"""Public auth/session helpers for A-Term HTTP and WebSocket access.

Every helper takes the ``AuthSettings`` it works under. The app builds them once (``get_auth_settings``) and keeps
them on ``app.state.trust.auth``; who gets in is decided in ``a_term.caller_trust``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from fastapi import Response

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
    """Build the auth configuration from the app settings."""
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


def _urlsafe_b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _urlsafe_b64decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _sign(data: str, secret: str) -> str:
    return _urlsafe_b64encode(
        hmac.new(secret.encode(), data.encode(), hashlib.sha256).digest()
    )


def create_password_session(settings: AuthSettings, now: int) -> AuthSession:
    """Build a new password-auth session."""
    return AuthSession(identity="owner", mode="password", expires_at=now + settings.session_ttl_seconds)


def create_proxy_session(identity: str, settings: AuthSettings, now: int) -> AuthSession:
    """Build a new proxy-auth session for the forwarded identity."""
    return AuthSession(identity=identity, mode="proxy", expires_at=now + settings.session_ttl_seconds)


def encode_session(session: AuthSession, settings: AuthSettings) -> str:
    """Serialize and sign a public auth session."""
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


def decode_session(token: str | None, settings: AuthSettings, now: int) -> AuthSession | None:
    """Verify and decode a signed session cookie against ``settings`` at time ``now``."""
    if not token:
        return None
    try:
        encoded_payload, encoded_signature = token.split(".", 1)
        payload = _urlsafe_b64decode(encoded_payload).decode()
    except (ValueError, UnicodeDecodeError):
        return None

    expected_signature = _sign(payload, settings.secret)
    if not hmac.compare_digest(encoded_signature.encode(), expected_signature.encode()):
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
    if session.expires_at <= now:
        return None
    return session


def get_proxy_identity(headers: Mapping[str, str], settings: AuthSettings) -> str | None:
    """The forwarded identity under ``settings``: proxy mode only, blank counts as none."""
    if settings.mode != "proxy":
        return None
    value = headers.get(settings.proxy_header)
    if value is None:
        return None
    identity = value.strip()
    return identity or None


def verify_password(password: str, settings: AuthSettings) -> bool:
    """Return whether a submitted password matches the configured secret."""
    if settings.mode != "password" or not settings.password:
        return False
    # JSON allows a lone surrogate ("\ud800"): encode it one-to-one instead of crashing with a 500.
    submitted = password.encode("utf-8", "surrogatepass")
    return hmac.compare_digest(submitted, settings.password.encode("utf-8", "surrogatepass"))


def set_session_cookie(response: Response, session: AuthSession, settings: AuthSettings) -> None:
    """Attach the signed session cookie to a response."""
    response.set_cookie(
        settings.cookie_name,
        encode_session(session, settings),
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        max_age=settings.session_ttl_seconds,
        path="/",
    )


def clear_session_cookie(response: Response, settings: AuthSettings) -> None:
    """Clear the auth session cookie."""
    response.delete_cookie(settings.cookie_name, path="/")
