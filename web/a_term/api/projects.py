"""A-Term Projects API - Project settings for a_term tabs.

This module provides:
- List projects with a_term settings merged
- Update a_term settings per project
- Bulk update display order for drag-and-drop
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..rate_limit import limiter
from ..services import lifecycle, project_catalog
from ..storage import project_settings as settings_store
from ..storage import projects as local_projects_store

router = APIRouter(tags=["A-Term Projects"])


# ============================================================================
# Request/Response Models
# ============================================================================


class ProjectResponse(BaseModel):
    """Project with a_term settings merged."""

    id: str
    name: str
    root_path: str | None
    # A-Term-specific settings
    a_term_enabled: bool = False
    mode: str = "shell"  # Active mode (shell or agent tool slug)
    display_order: int = 0


class ProjectSettingsUpdate(BaseModel):
    """Request to update a_term settings for a project."""

    enabled: bool | None = None
    active_mode: str | None = Field(None, pattern=r"^[a-z0-9_-]+$", max_length=100)
    display_order: int | None = None


class SetModeRequest(BaseModel):
    """Request to set active mode for a project."""

    mode: str = Field(..., pattern=r"^[a-z0-9_-]+$", max_length=100)


class BulkOrderUpdate(BaseModel):
    """Request to bulk update display order."""

    project_ids: list[str]


class CreateProjectRequest(BaseModel):
    """Request to register a local project in standalone mode."""

    root_path: str = Field(..., min_length=1, max_length=4096)
    name: str | None = Field(None, max_length=120)


class ProjectRegistryContextResponse(BaseModel):
    """Describe which project catalog is active."""

    source: Literal["local", "companion"]
    can_register: bool


async def _get_project_lookup() -> dict[str, dict[str, Any]]:
    """Fetch projects from the active catalog and return keyed by ID."""
    projects = await project_catalog.list_projects()
    return {project.get("id", ""): project for project in projects if project.get("id")}


def _build_project_response(
    project_id: str,
    settings: dict[str, Any] | None,
    project_lookup: dict[str, dict[str, Any]],
) -> ProjectResponse:
    """Merge SummitFlow project metadata with local a_term settings."""
    project = project_lookup.get(project_id, {})
    return ProjectResponse(
        id=project_id,
        name=project.get("name", project_id),
        root_path=project.get("root_path"),
        a_term_enabled=settings["enabled"] if settings else False,
        mode=settings["active_mode"] if settings else "shell",
        display_order=settings["display_order"] if settings else 0,
    )


# ============================================================================
# Endpoints
# ============================================================================


@router.get("/api/a-term/projects", response_model=list[ProjectResponse])
async def list_projects() -> list[ProjectResponse]:
    """List all projects with a_term settings merged.

    Fetches projects from the active catalog source and merges with local
    a_term_project_settings. Projects without settings get defaults.
    """
    project_lookup = await _get_project_lookup()

    # Get all local a_term settings
    all_settings = settings_store.get_all_settings()

    # Merge and build response
    result = [
        _build_project_response(project_id, all_settings.get(project_id), project_lookup)
        for project_id in project_lookup
    ]

    # Sort by display_order, then by name
    result.sort(key=lambda p: (p.display_order, p.name))

    return result


@router.get("/api/a-term/projects/context", response_model=ProjectRegistryContextResponse)
async def get_project_registry_context() -> ProjectRegistryContextResponse:
    """Describe whether the local or companion project catalog is active."""
    return ProjectRegistryContextResponse(
        source=project_catalog.get_catalog_source(),
        can_register=project_catalog.can_register_projects(),
    )


@router.post("/api/a-term/projects", response_model=ProjectResponse)
async def create_project(request: CreateProjectRequest) -> ProjectResponse:
    """Register a local project in standalone mode."""
    if not project_catalog.can_register_projects():
        raise HTTPException(
            status_code=409,
            detail="Projects are managed by SummitFlow while the companion API is configured",
        ) from None

    try:
        project = local_projects_store.create_project(
            name=request.name,
            root_path=request.root_path,
        )
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from None
    settings = settings_store.get_all_settings().get(project["id"])
    project_lookup = {project["id"]: project}
    return _build_project_response(project["id"], settings, project_lookup)


@router.put("/api/a-term/project-settings/{project_id}", response_model=ProjectResponse)
async def update_project_settings(
    project_id: str,
    update: ProjectSettingsUpdate,
) -> ProjectResponse:
    """Update a_term settings for a project.

    Creates settings if they don't exist (upsert).
    """
    # Upsert the settings
    settings = settings_store.upsert_settings(
        project_id=project_id,
        enabled=update.enabled,
        active_mode=update.active_mode,
        display_order=update.display_order,
    )

    project_lookup = await _get_project_lookup()
    return _build_project_response(project_id, settings, project_lookup)


@router.post("/api/a-term/project-settings/bulk-order", response_model=list[ProjectResponse])
async def bulk_update_order(update: BulkOrderUpdate) -> list[ProjectResponse]:
    """Bulk update display order for drag-and-drop reordering.

    The order in the project_ids list becomes the display_order.
    """
    settings_store.bulk_update_order(update.project_ids)

    # Return updated project list
    return await list_projects()


@router.post("/api/a-term/projects/{project_id}/reset")
@limiter.limit("5/minute")
async def reset_project(request: Request, project_id: str) -> dict[str, Any]:
    """Reset all a_term sessions for a project.

    Resets the shell session and the current default agent session if they exist.
    Uses the current project root_path from the active project catalog.
    Also resets mode back to shell.
    Returns new session IDs for each mode.
    """
    project_lookup = await _get_project_lookup()
    project_info = project_lookup.get(project_id)
    working_dir = project_info.get("root_path") if project_info else None

    # Reset sessions
    result = lifecycle.reset_project_sessions(project_id, working_dir=working_dir)

    # Reset mode back to shell
    settings_store.upsert_settings(project_id=project_id, active_mode="shell")

    # Find the agent session ID (non-shell key)
    agent_mode = next((k for k in result if k != "shell"), None)
    agent_session_id = result.get(agent_mode) if agent_mode else None
    return {
        "project_id": project_id,
        "shell_session_id": result.get("shell"),
        "agent_session_id": agent_session_id,
        "mode": "shell",
        "agent_mode": agent_mode,
    }


@router.post("/api/a-term/projects/{project_id}/disable", response_model=ProjectResponse)
async def disable_project(project_id: str) -> ProjectResponse:
    """Disable a_term for a project.

    Deletes all sessions and sets enabled=false in settings.
    """
    lifecycle.disable_project_a_term(project_id)
    project_lookup = await _get_project_lookup()
    settings = settings_store.get_all_settings().get(project_id)
    return _build_project_response(project_id, settings, project_lookup)


@router.put("/api/a-term/projects/{project_id}/mode", response_model=ProjectResponse)
async def set_project_mode(project_id: str, request: SetModeRequest) -> ProjectResponse:
    """Set the active mode for a project.

    Updates the active_mode in project settings. This mode syncs across devices.
    """
    result = settings_store.set_active_mode(project_id, request.mode)
    if not result:
        # Create settings if they don't exist
        result = settings_store.upsert_settings(project_id, active_mode=request.mode)

    project_lookup = await _get_project_lookup()
    return _build_project_response(project_id, result, project_lookup)
