"""Canonical project catalog for A-Term standalone and companion modes."""

from __future__ import annotations

from typing import Any, Literal

from ..storage import projects as local_projects
from . import summitflow_client

ProjectCatalogSource = Literal["local", "companion"]


def get_catalog_source() -> ProjectCatalogSource:
    """Return which backing catalog is currently authoritative."""
    return "companion" if summitflow_client.has_companion_api() else "local"


def can_register_projects() -> bool:
    """Return whether A-Term can register projects locally."""
    return get_catalog_source() == "local"


async def list_projects() -> list[dict[str, Any]]:
    """List projects from the active catalog source."""
    if get_catalog_source() == "companion":
        return await summitflow_client.list_projects()
    local_projects.sync_workspace_projects()
    return local_projects.list_projects()
