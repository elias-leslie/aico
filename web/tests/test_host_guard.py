"""The backend answers only a loopback Host, so nothing that forwards another Host (Caddy, DNS rebinding) reaches it."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from .conftest import LOOPBACK_BASE_URL, LOOPBACK_WS_URL

FOREIGN_HOSTS = [
    "terminal.summitflow.dev",  # Caddy :443 forwards the original Host
    "evil.example:8002",  # DNS rebinding keeps the attacker's name
    "192.168.86.128:8002",  # LAN address
    "testserver",
    "localhost.evil.example",
    "127.0.0.1.evil.example",
    "evil.example@127.0.0.1",
    "127.0.0.1:8002@evil.example",
    "localhost:8002 ",
    "[::1].evil.example",
    "",
]


def _client(test_app: TestClient, host: str) -> TestClient:
    return TestClient(test_app.app, base_url=LOOPBACK_BASE_URL, headers={"host": host}, raise_server_exceptions=False)


@pytest.mark.parametrize("host", FOREIGN_HOSTS)
@pytest.mark.parametrize(
    ("method", "path"),
    [("GET", "/api/a-term/panes"), ("GET", "/health"), ("POST", "/api/a-term/reset-all"), ("GET", "/v1/roots")],
)
def test_foreign_host_is_refused(test_app: TestClient, host: str, method: str, path: str) -> None:
    response = _client(test_app, host).request(method, path)
    assert response.status_code == 403
    assert response.json() == {"error": "host_not_allowed"}


def test_forwarded_host_does_not_unlock_a_foreign_host(test_app: TestClient) -> None:
    response = _client(test_app, "terminal.summitflow.dev").get(
        "/api/a-term/panes", headers={"x-forwarded-host": "127.0.0.1:8002"}
    )
    assert response.status_code == 403


def test_forwarded_host_is_ignored_for_a_loopback_host(test_app: TestClient) -> None:
    # Next's rewrite sends Host 127.0.0.1:8002 and X-Forwarded-Host terminal.summitflow.dev (the tunnel path).
    response = test_app.get("/api/a-term/panes", headers={"x-forwarded-host": "terminal.summitflow.dev"})
    assert response.status_code == 200


@pytest.mark.parametrize("host", ["127.0.0.1:8002", "127.0.0.1", "localhost:8002", "LOCALHOST", "[::1]:8002", "[::1]"])
def test_loopback_hosts_are_served(test_app: TestClient, host: str) -> None:
    assert _client(test_app, host).get("/api/a-term/panes").status_code == 200


@pytest.mark.parametrize("host", ["terminal.summitflow.dev", "evil.example:8002", "192.168.86.128:8002"])
def test_foreign_host_websocket_is_closed_1008(test_app: TestClient, host: str) -> None:
    with pytest.raises(WebSocketDisconnect) as refused, _client(test_app, host).websocket_connect("/ws/a-term/s1"):
        pass
    assert refused.value.code == 1008


@pytest.mark.parametrize("ws_url", [LOOPBACK_WS_URL, "ws://127.0.0.1:8002", "ws://[::1]:8002"])
def test_loopback_host_websocket_attaches(test_app: TestClient, ws_url: str) -> None:
    async def accept_then_close(websocket: WebSocket, *_args: object) -> None:
        await websocket.accept()
        await websocket.close()

    handler = AsyncMock(side_effect=accept_then_close)
    with patch("a_term.api.a_term.handle_a_term_connection", handler), test_app.websocket_connect(f"{ws_url}/ws/a-term/s1"):
        pass
    handler.assert_awaited_once()
