"""HTTP client for SummitFlow API.

This module provides async functions to fetch data from the SummitFlow
backend API, primarily for listing projects to populate a_term settings.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from ..config import SUMMITFLOW_API_BASE
from ..logging_config import get_logger

logger = get_logger(__name__)

_client: httpx.AsyncClient | None = None
_cache: list[dict[str, Any]] | None = None
_cache_time: float = 0.0
_CACHE_TTL_SECONDS = 60.0


def _get_client() -> httpx.AsyncClient:
    """Return the module-level AsyncClient, creating it on first call."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=10.0)
    return _client


async def close_client() -> None:
    """Close and discard the module-level AsyncClient. Call on shutdown."""
    global _client, _cache
    if _client is not None:
        await _client.aclose()
        _client = None
    _cache = None


async def list_projects() -> list[dict[str, Any]]:
    """Fetch all projects from SummitFlow API (cached for 60s).

    Returns:
        List of project dicts with at least: id, name, root_path
        Returns empty list on connection errors (fails gracefully)
    """
    global _cache, _cache_time
    if _cache is not None and (time.monotonic() - _cache_time) < _CACHE_TTL_SECONDS:
        return _cache

    if not SUMMITFLOW_API_BASE.strip():
        return _cache or []

    url = f"{SUMMITFLOW_API_BASE}/projects"
    try:
        client = _get_client()
        response = await client.get(url)
        response.raise_for_status()
        result: list[dict[str, Any]] = response.json()
        _cache = result
        _cache_time = time.monotonic()
        return result
    except httpx.ConnectError:
        logger.warning("summitflow_api_connect_error", url=url)
        return _cache or []
    except httpx.TimeoutException:
        logger.warning("summitflow_api_timeout", url=url)
        return _cache or []
    except httpx.HTTPStatusError as e:
        logger.error("summitflow_api_http_error", status_code=e.response.status_code)
        return _cache or []
    except Exception as e:
        logger.error("summitflow_api_unexpected_error", error=str(e))
        return _cache or []
