"""Tests for the optional SummitFlow companion client."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from aterm.services import summitflow_client


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

