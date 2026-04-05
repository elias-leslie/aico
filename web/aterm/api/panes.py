"""A-Term Panes API - REST endpoints for pane management.

This module provides:
- List aterm panes with their sessions
- Create new pane (atomically creates sessions)
- Update pane metadata (name, order, active_mode)
- Delete pane (cascades to sessions)
- Swap pane positions

Panes are containers for 1-2 sessions:
- Project panes: shell + default agent sessions (toggled via active_mode)
- Ad-hoc panes: shell session only
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..constants import MAX_PANES
from ..rate_limit import limiter
from ..services.lifecycle import create_session, delete_session, kill_tmux_session
from ..storage import agent_tools as agent_tools_store
from ..storage import panes as pane_store
from .models.panes import (
    BulkLayoutUpdateRequest,
    CreatePaneRequest,
    PaneListResponse,
    PaneResponse,
    SwapPanesRequest,
    SwitchAgentToolRequest,
    UpdatePaneLayoutRequest,
    UpdatePaneOrderRequest,
    UpdatePaneRequest,
)
from .pane_responses import build_pane_response
from .validators import (
    require_pane_exists,
    validate_active_mode,
    validate_create_pane_request,
    validate_uuid,
)

router = APIRouter(tags=["A-Term Panes"])


@router.get("/api/aterm/panes", response_model=PaneListResponse)
async def list_panes() -> PaneListResponse:
    """List all aterm panes with their sessions."""
    panes = pane_store.list_panes_with_sessions()
    return PaneListResponse(
        items=[build_pane_response(p) for p in panes],
        total=len(panes),
        max_panes=MAX_PANES,
    )


@router.get("/api/aterm/panes/detached", response_model=PaneListResponse)
async def list_detached_panes() -> PaneListResponse:
    """List detached panes that can be reattached."""
    panes = [p for p in pane_store.list_panes_with_sessions(include_detached=True) if p.get("is_detached")]
    return PaneListResponse(
        items=[build_pane_response(p) for p in panes],
        total=len(panes),
        max_panes=MAX_PANES,
    )


@router.get("/api/aterm/panes/count")
async def get_pane_count() -> dict[str, Any]:
    """Get current pane count and max limit."""
    count = pane_store.count_panes()
    return {
        "count": count,
        "max_panes": MAX_PANES,
        "at_limit": count >= MAX_PANES,
    }


@router.post("/api/aterm/panes", response_model=PaneResponse)
@limiter.limit("20/minute")
async def create_pane(request: Request, body: CreatePaneRequest) -> PaneResponse:
    """Create a new aterm pane with sessions.

    For project panes: creates shell + default agent sessions.
    For adhoc panes: creates shell session only.
    """
    validate_create_pane_request(body.pane_type, body.project_id)
    if body.agent_tool_slug is not None:
        _validate_agent_tool(body.agent_tool_slug)

    try:
        pane = pane_store.create_pane_with_sessions(
            pane_type=body.pane_type,
            pane_name=body.pane_name,
            project_id=body.project_id,
            working_dir=body.working_dir,
            agent_tool_slug=body.agent_tool_slug,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None

    return build_pane_response(pane)


@router.get("/api/aterm/panes/{pane_id}", response_model=PaneResponse)
async def get_pane(pane_id: str) -> PaneResponse:
    """Get a single aterm pane with its sessions."""
    validate_uuid(pane_id)

    pane = require_pane_exists(pane_store.get_pane_with_sessions(pane_id), pane_id)
    return build_pane_response(pane)


@router.patch("/api/aterm/panes/{pane_id}", response_model=PaneResponse)
async def update_pane(pane_id: str, request: UpdatePaneRequest) -> PaneResponse:
    """Update aterm pane metadata (pane_name, active_mode)."""
    validate_uuid(pane_id)

    existing = require_pane_exists(pane_store.get_pane_with_sessions(pane_id), pane_id)

    if request.active_mode is not None:
        available_modes = {s.get("mode", "shell") for s in existing.get("sessions", [])}
        validate_active_mode(existing["pane_type"], request.active_mode, available_modes)

    update_fields = {k: v for k, v in {"pane_name": request.pane_name, "active_mode": request.active_mode}.items() if v is not None}
    if not update_fields:
        return build_pane_response(existing)

    pane = pane_store.update_pane(pane_id, **update_fields)
    if not pane:
        raise HTTPException(status_code=500, detail="Failed to update pane") from None

    pane_with_sessions = pane_store.get_pane_with_sessions(pane_id)
    return build_pane_response(pane_with_sessions or existing)


@router.delete("/api/aterm/panes/{pane_id}")
async def delete_pane(pane_id: str) -> dict[str, Any]:
    """Delete a aterm pane and all its sessions.

    Kills tmux sessions first to prevent orphaned processes,
    then deletes DB records (pane + sessions).
    """
    validate_uuid(pane_id)

    # Kill tmux sessions before deleting DB records to prevent orphans
    sessions = pane_store.fetch_sessions_for_pane(pane_id)
    for session in sessions:
        kill_tmux_session(session["id"], ignore_missing=True)

    deleted = pane_store.delete_pane(pane_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Pane {pane_id} not found") from None
    return {"deleted": True, "id": pane_id}


@router.post("/api/aterm/panes/{pane_id}/detach", response_model=PaneResponse)
async def detach_pane(pane_id: str) -> PaneResponse:
    """Detach a pane from the visible layout while preserving its sessions."""
    validate_uuid(pane_id)

    pane = require_pane_exists(pane_store.get_pane_with_sessions(pane_id), pane_id)
    if pane.get("is_detached"):
        return build_pane_response(pane)

    updated = pane_store.detach_pane(pane_id)
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to detach pane") from None
    return build_pane_response({**pane, **updated, "sessions": pane.get("sessions", [])})


@router.post("/api/aterm/panes/{pane_id}/attach", response_model=PaneResponse)
async def attach_pane(pane_id: str) -> PaneResponse:
    """Attach a detached pane back into the visible layout."""
    validate_uuid(pane_id)

    pane = require_pane_exists(pane_store.get_pane_with_sessions(pane_id), pane_id)
    if not pane.get("is_detached"):
        return build_pane_response(pane)

    try:
        updated = pane_store.attach_pane(pane_id)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from None

    if not updated:
        raise HTTPException(status_code=500, detail="Failed to attach pane") from None
    return build_pane_response({**pane, **updated, "sessions": pane.get("sessions", [])})


@router.post("/api/aterm/panes/swap")
async def swap_panes(request: SwapPanesRequest) -> dict[str, Any]:
    """Swap positions of two panes."""
    success = pane_store.swap_pane_positions(request.pane_id_a, request.pane_id_b)
    if not success:
        raise HTTPException(status_code=404, detail="One or both panes not found") from None
    return {
        "swapped": True,
        "pane_id_a": request.pane_id_a,
        "pane_id_b": request.pane_id_b,
    }


@router.put("/api/aterm/panes/order")
async def update_pane_order(request: UpdatePaneOrderRequest) -> dict[str, Any]:
    """Batch update pane ordering."""
    pane_store.update_pane_order(request.pane_orders)
    return {"updated": True, "count": len(request.pane_orders)}


@router.patch("/api/aterm/panes/{pane_id}/layout", response_model=PaneResponse)
async def update_pane_layout(pane_id: str, request: UpdatePaneLayoutRequest) -> PaneResponse:
    """Update a single pane's layout (position and size)."""
    validate_uuid(pane_id)

    existing = require_pane_exists(pane_store.get_pane(pane_id), pane_id)

    update_fields = {k: v for k, v in {
        "width_percent": request.width_percent, "height_percent": request.height_percent,
        "grid_row": request.grid_row, "grid_col": request.grid_col,
    }.items() if v is not None}
    if not update_fields:
        pane = pane_store.get_pane_with_sessions(pane_id)
        return build_pane_response(pane or existing)

    pane = pane_store.update_pane(pane_id, **update_fields)
    if not pane:
        raise HTTPException(status_code=500, detail="Failed to update pane layout") from None

    pane_with_sessions = pane_store.get_pane_with_sessions(pane_id)
    return build_pane_response(pane_with_sessions or pane)


@router.put("/api/aterm/layout", response_model=list[PaneResponse])
async def update_all_pane_layouts(
    request: BulkLayoutUpdateRequest,
) -> list[PaneResponse]:
    """Bulk update layout for all panes at once."""
    if not request.layouts:
        return []

    layouts_data = [
        {k: item.get(k) for k in ("pane_id", "width_percent", "height_percent", "grid_row", "grid_col")}
        for item in (item.model_dump() for item in request.layouts)
    ]
    pane_store.update_pane_layouts(layouts_data)

    all_panes = pane_store.list_panes_with_sessions()
    return [build_pane_response(p) for p in all_panes]


def _validate_agent_tool(slug: str) -> None:
    """Validate agent tool exists and is enabled. Raises HTTPException otherwise."""
    tool = agent_tools_store.get_by_slug(slug)
    if not tool:
        raise HTTPException(status_code=404, detail=f"Agent tool '{slug}' not found") from None
    if not tool["enabled"]:
        raise HTTPException(status_code=400, detail=f"Agent tool '{tool['name']}' is disabled") from None


def _replace_agent_session(pane: dict[str, Any], pane_id: str, agent_tool_slug: str) -> None:
    """Replace an existing agent session with a new one using the given tool slug.

    Prefers shell session's working_dir as it's more likely to be accurate.
    """
    agent_session = next(
        (s for s in pane.get("sessions", []) if s.get("mode") != "shell"),
        None,
    )
    if agent_session:
        delete_session(agent_session["id"])

    shell_session = next(
        (s for s in pane.get("sessions", []) if s.get("mode") == "shell"),
        None,
    )
    working_dir = shell_session.get("working_dir") if shell_session else None
    project_id = pane.get("project_id")
    session_name = f"Project: {project_id}" if project_id else pane.get("pane_name", "A-Term")
    create_session(
        name=session_name,
        project_id=project_id,
        working_dir=working_dir,
        mode=agent_tool_slug,
        pane_id=pane_id,
    )


@router.put("/api/aterm/panes/{pane_id}/agent-tool", response_model=PaneResponse)
@limiter.limit("20/minute")
async def switch_agent_tool(request: Request, pane_id: str, body: SwitchAgentToolRequest) -> PaneResponse:
    """Switch the agent tool on a pane.

    Finds the agent session on the pane, kills its tmux session,
    updates the session mode, recreates tmux, and returns the updated pane.
    """
    validate_uuid(pane_id)

    pane = require_pane_exists(pane_store.get_pane_with_sessions(pane_id), pane_id)
    if pane["pane_type"] != "project":
        raise HTTPException(status_code=400, detail="Only project panes support agent tools") from None

    _validate_agent_tool(body.agent_tool_slug)
    _replace_agent_session(pane, pane_id, body.agent_tool_slug)
    pane_store.update_pane(pane_id, active_mode=body.agent_tool_slug)

    pane_with_sessions = pane_store.get_pane_with_sessions(pane_id)
    return build_pane_response(pane_with_sessions or pane)
