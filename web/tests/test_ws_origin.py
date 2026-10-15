"""The terminal WebSocket refuses browser pages from other sites before it attaches to any session."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

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
