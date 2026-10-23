"""Tests for public authentication and session enforcement."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from a_term.config import Settings

from .conftest import LOOPBACK_WS_URL


def test_password_auth_blocks_api_without_session(test_app: TestClient, auth_settings) -> None:
    auth_settings()
    response = test_app.get("/api/diagnostics/sessions")

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


def test_password_auth_login_sets_cookie_and_allows_api(test_app: TestClient, auth_settings) -> None:
    auth_settings()
    login_response = test_app.post(
        "/api/auth/login",
        json={"password": "correct horse battery staple"},
    )

    assert login_response.status_code == 200
    assert "a_term_session=" in login_response.headers["set-cookie"]

    response = test_app.get("/api/diagnostics/sessions")

    assert response.status_code == 200
    assert "sessions" in response.json()


def test_proxy_auth_bootstraps_from_forwarded_identity(test_app: TestClient, auth_settings) -> None:
    auth_settings(mode="proxy", password="")
    response = test_app.get(
        "/api/auth/session",
        headers={"X-Forwarded-User": "owner@example.com"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "mode": "proxy",
        "authenticated": True,
        "identity": "owner@example.com",
    }
    assert "a_term_session=" in response.headers["set-cookie"]


def test_health_stays_public_when_auth_is_enabled(test_app: TestClient, auth_settings) -> None:
    auth_settings()
    response = test_app.get("/health")

    assert response.status_code == 200


def test_websocket_requires_auth_when_enabled(test_app: TestClient, auth_settings) -> None:
    auth_settings()
    handler = AsyncMock()
    with (
        patch("a_term.api.a_term.handle_a_term_connection", handler),
        pytest.raises(WebSocketDisconnect),test_app.websocket_connect(f"{LOOPBACK_WS_URL}/ws/a-term/session-1")
    ):
        pass

    handler.assert_not_awaited()


def test_websocket_accepts_authenticated_session_cookie(test_app: TestClient, auth_settings) -> None:
    auth_settings()
    handler = AsyncMock()

    async def fake_handler(websocket: WebSocket, *_args: object, **_kwargs: object) -> None:
        await websocket.accept()
        await websocket.close()

    handler.side_effect = fake_handler
    with patch("a_term.api.a_term.handle_a_term_connection", handler):
        login_response = test_app.post(
            "/api/auth/login",
            json={"password": "correct horse battery staple"},
        )
        assert login_response.status_code == 200

        with test_app.websocket_connect(f"{LOOPBACK_WS_URL}/ws/a-term/session-1"):
            pass

    handler.assert_awaited_once()


def test_settings_require_auth_for_non_loopback_hosts() -> None:
    with pytest.raises(ValueError, match="The web backend must not bind to non-loopback"):
        Settings(
            database_url="postgresql://user:pass@localhost:5432/a-term",
            a_term_bind_host="0.0.0.0",
            a_term_auth_mode="none",
        )


def test_settings_require_password_and_secret_for_password_mode() -> None:
    with pytest.raises(ValueError, match="A_TERM_AUTH_PASSWORD is required"):
        Settings(
            database_url="postgresql://user:pass@localhost:5432/a-term",
            a_term_bind_host="127.0.0.1",
            a_term_auth_mode="password",
            a_term_auth_secret="test-secret",
        )

    with pytest.raises(ValueError, match="A_TERM_AUTH_SECRET is required"):
        Settings(
            database_url="postgresql://user:pass@localhost:5432/a-term",
            a_term_bind_host="127.0.0.1",
            a_term_auth_mode="password",
            a_term_auth_password="secret",
        )


def test_non_ascii_password_and_cookie_are_refused_not_crashed(test_app: TestClient, auth_settings) -> None:
    auth_settings()
    assert test_app.post("/api/auth/login", json={"password": "caf\u00e9"}).status_code == 401
    # A well-formed payload with a non-ASCII signature.
    cookie = "a_term_session=e30.caf\u00e9".encode("latin-1")
    response = test_app.get("/api/diagnostics/sessions", headers={"cookie": cookie})
    assert response.status_code == 401


def test_lone_surrogate_password_is_refused_not_crashed(test_app: TestClient, auth_settings) -> None:
    auth_settings()
    response = test_app.post(
        "/api/auth/login", content=b'{"password": "\\ud800"}', headers={"content-type": "application/json"}
    )
    assert response.status_code == 401
