"""Tests for the optional SummitFlow companion client."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from a_term.services import summitflow_client


@pytest.mark.asyncio
async def test_list_projects_skips_fetch_when_companion_base_is_blank() -> None:
    """Blank companion config disables network fetches cleanly."""
    await summitflow_client.close_client()

    with (
        patch.object(summitflow_client, "SUMMITFLOW_API_BASE", ""),
        patch.object(summitflow_client, "_get_client") as mock_get_client,
    ):
        assert await summitflow_client.list_projects() == []

    mock_get_client.assert_not_called()


@pytest.mark.asyncio
async def test_api_request_builds_path_from_companion_base() -> None:
    """Generic proxy requests should reuse the configured companion API base."""
    mock_client = AsyncMock()
    mock_client.request.return_value = object()

    with (
        patch.object(summitflow_client, "SUMMITFLOW_API_BASE", "http://localhost:8001/api"),
        patch.object(summitflow_client, "_get_client", return_value=mock_client),
    ):
        await summitflow_client.api_request(
            "GET",
            "/notes/capabilities",
            params=[("limit", "1")],
        )

    mock_client.request.assert_awaited_once_with(
        "GET",
        "http://localhost:8001/api/notes/capabilities",
        params=[("limit", "1")],
        content=None,
        headers=None,
    )


@pytest.mark.asyncio
async def test_list_projects_closes_companion_response() -> None:
    """Project catalog fetches should release their upstream response."""
    await summitflow_client.close_client()

    upstream = httpx.Response(
        200,
        json=[{"id": "agent-hub", "name": "Agent Hub", "root_path": "/srv/agent-hub"}],
        request=httpx.Request("GET", "http://localhost:8001/api/projects"),
    )
    mock_client = AsyncMock()
    mock_client.request.return_value = upstream

    with (
        patch.object(
            summitflow_client,
            "SUMMITFLOW_API_BASE",
            "http://localhost:8001/api",
        ),
        patch.object(summitflow_client, "_get_client", return_value=mock_client),
        patch.object(upstream, "aclose", wraps=upstream.aclose) as close_response,
    ):
        result = await summitflow_client.list_projects()

    assert result == [
        {"id": "agent-hub", "name": "Agent Hub", "root_path": "/srv/agent-hub"}
    ]
    mock_client.request.assert_awaited_once_with(
        "GET",
        "http://localhost:8001/api/projects",
        params=None,
        content=None,
        headers={"Connection": "close"},
    )
    close_response.assert_awaited_once()
