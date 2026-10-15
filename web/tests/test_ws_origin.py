"""The terminal WebSocket refuses browser pages from other sites before it attaches to any session."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from a_term.api import a_term as a_term_api


def _ws(origin: str | None) -> MagicMock:
    ws = MagicMock()
    ws.headers = {} if origin is None else {"origin": origin}
    ws.close = AsyncMock()
    return ws


@pytest.mark.asyncio
async def test_foreign_origin_is_refused_before_attach(monkeypatch: pytest.MonkeyPatch) -> None:
    attach = AsyncMock()
    monkeypatch.setattr(a_term_api, "handle_a_term_connection", attach)
    ws = _ws("https://evil.example")
    await a_term_api.a_term_websocket(ws, "s1")
    ws.close.assert_awaited_once()
    assert ws.close.await_args.kwargs["code"] == 1008
    attach.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", [None, "http://localhost:3002", "https://terminal.summitflow.dev"])
async def test_own_origins_and_originless_clients_attach(monkeypatch: pytest.MonkeyPatch, origin: str | None) -> None:
    attach = AsyncMock()
    monkeypatch.setattr(a_term_api, "handle_a_term_connection", attach)
    monkeypatch.setattr(a_term_api, "authenticate_websocket", lambda ws: object())
    ws = _ws(origin)
    await a_term_api.a_term_websocket(ws, "s1")
    attach.assert_awaited_once()


@pytest.mark.parametrize(
    ("origin", "refused"),
    [("https://evil.example", True), ("null", True), (None, False), ("http://localhost:3002", False)],
)
def test_state_changing_requests_refuse_other_sites(test_app: TestClient, origin: str | None, refused: bool) -> None:
    headers = {} if origin is None else {"origin": origin}
    response = test_app.post("/api/a-term/reset-all", headers=headers)
    assert (response.status_code == 403 and response.json() == {"error": "origin_not_allowed"}) is refused


def test_reads_from_other_sites_are_not_refused_by_the_guard(test_app: TestClient) -> None:
    assert test_app.get("/health", headers={"origin": "https://evil.example"}).status_code == 200
