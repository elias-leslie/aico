"""Other sites' pages are refused on writes, and CORS answers only the one origin list.

The terminal WebSocket's Origin and auth refusals are pinned in the golden table (test_caller_trust_golden); the
table tries one of our origins, so every origin in the list is checked to attach here.
"""

from __future__ import annotations

from typing import cast
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient

from .conftest import LOOPBACK_WS_URL


@pytest.mark.parametrize(
    ("origin", "refused"),
    [("https://evil.example", True), ("null", True), (None, False), ("http://localhost:3002", False)],
)
def test_state_changing_requests_refuse_other_sites(test_app: TestClient, origin: str | None, refused: bool) -> None:
    headers = {} if origin is None else {"origin": origin}
    response = test_app.post("/api/a-term/reset-all", headers=headers)
    assert (response.status_code == 403 and response.json() == {"error": "origin_not_allowed"}) is refused


@pytest.mark.parametrize("origin", ["http://127.0.0.1:3002", "https://aico.summitflow.dev"])
def test_cors_and_the_write_guard_use_the_same_list(test_app: TestClient, origin: str) -> None:
    preflight = test_app.options(
        "/api/a-term/reset-all", headers={"origin": origin, "access-control-request-method": "POST"}
    )
    assert preflight.headers.get("access-control-allow-origin") == origin
    assert test_app.post("/api/a-term/reset-all", headers={"origin": origin}).status_code != 403


def test_cors_does_not_answer_other_sites(test_app: TestClient) -> None:
    preflight = test_app.options(
        "/api/a-term/reset-all", headers={"origin": "https://evil.example", "access-control-request-method": "POST"}
    )
    assert "access-control-allow-origin" not in preflight.headers


def test_reads_from_other_sites_are_not_refused_by_the_guard(test_app: TestClient) -> None:
    assert test_app.get("/health", headers={"origin": "https://evil.example"}).status_code == 200


@pytest.mark.parametrize(
    "origin", [None, "http://localhost:3002", "http://127.0.0.1:3002", "https://aico.summitflow.dev"]
)
def test_terminal_websocket_attaches_for_every_own_origin(test_app: TestClient, origin: str | None) -> None:
    assert origin is None or origin in cast(FastAPI, test_app.app).state.trust.allowed_origins

    async def accept_then_close(websocket: WebSocket, *_args: object) -> None:
        await websocket.accept()
        await websocket.close()

    attach = AsyncMock(side_effect=accept_then_close)
    headers = {} if origin is None else {"origin": origin}
    with (
        patch("a_term.api.a_term.handle_a_term_connection", attach),
        test_app.websocket_connect(f"{LOOPBACK_WS_URL}/ws/a-term/s1", headers=headers),
    ):
        pass
    attach.assert_awaited_once()
