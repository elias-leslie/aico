"""Agent Tools API - CRUD endpoints for CLI agent tool management.

Provides:
- List agent tools (with optional enabled filter)
- Create new agent tool
- Update agent tool (slug immutable after creation)
- Delete agent tool (guarded: no active sessions)
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..storage import agent_tools as agent_tools_store

router = APIRouter(tags=["Agent Tools"])


# ============================================================================
# Request/Response Models
# ============================================================================


class AgentToolResponse(BaseModel):
    id: str
    name: str
    slug: str
    command: str
    process_name: str
    description: str | None = None
    color: str | None = None
    display_order: int = 0
    is_default: bool = False
    enabled: bool = True
    created_at: str | None = None
    updated_at: str | None = None


class CreateAgentToolRequest(BaseModel):
    name: str = Field(max_length=100)
    slug: str = Field(max_length=50, pattern=r"^[a-z0-9_-]+$")
    command: str
    process_name: str = Field(max_length=100)
    description: str | None = None
    color: str | None = Field(default=None, max_length=20)
    display_order: int = 0
    is_default: bool = False
    enabled: bool = True


class UpdateAgentToolRequest(BaseModel):
    name: str | None = None
    command: str | None = None
    process_name: str | None = None
    description: str | None = None
    color: str | None = None
    display_order: int | None = None
    is_default: bool | None = None
    enabled: bool | None = None


def _to_response(tool: dict[str, Any]) -> AgentToolResponse:
    """Convert storage dict to response model."""
    return AgentToolResponse(
        id=str(tool["id"]),
        name=tool["name"],
        slug=tool["slug"],
        command=tool["command"],
        process_name=tool["process_name"],
        description=tool.get("description"),
        color=tool.get("color"),
        display_order=tool.get("display_order", 0),
        is_default=tool.get("is_default", False),
        enabled=tool.get("enabled", True),
        created_at=str(tool["created_at"]) if tool.get("created_at") else None,
        updated_at=str(tool["updated_at"]) if tool.get("updated_at") else None,
    )


# ============================================================================
# Endpoints
# ============================================================================


@router.get("/api/a-term/agent-tools", response_model=list[AgentToolResponse])
def list_agent_tools(enabled_only: bool = False) -> list[AgentToolResponse]:
    """List all agent tools, optionally filtered to enabled only."""
    tools = agent_tools_store.list_enabled() if enabled_only else agent_tools_store.list_all()
    return [_to_response(t) for t in tools]


@router.post("/api/a-term/agent-tools", response_model=AgentToolResponse, status_code=201)
def create_agent_tool(body: CreateAgentToolRequest) -> AgentToolResponse:
    """Create a new agent tool."""
    # Check slug uniqueness
    existing = agent_tools_store.get_by_slug(body.slug)
    if existing:
        raise HTTPException(status_code=409, detail=f"Agent tool with slug '{body.slug}' already exists") from None

    try:
        tool = agent_tools_store.create(
            name=body.name,
            slug=body.slug,
            command=body.command,
            process_name=body.process_name,
            description=body.description,
            color=body.color,
            display_order=body.display_order,
            is_default=body.is_default,
            enabled=body.enabled,
        )
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create agent tool: {e}") from None

    return _to_response(tool)


@router.patch("/api/a-term/agent-tools/{tool_id}", response_model=AgentToolResponse)
def update_agent_tool(tool_id: str, body: UpdateAgentToolRequest) -> AgentToolResponse:
    """Update an agent tool. Slug is immutable after creation."""
    existing = agent_tools_store.get_by_id(tool_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"Agent tool {tool_id} not found") from None

    updates = body.model_dump(exclude_none=True)
    if not updates:
        return _to_response(existing)

    tool = agent_tools_store.update(tool_id, **updates)
    if not tool:
        raise HTTPException(status_code=500, detail="Failed to update agent tool") from None

    return _to_response(tool)


@router.delete("/api/a-term/agent-tools/{tool_id}")
def delete_agent_tool(tool_id: str) -> dict[str, Any]:
    """Delete an agent tool. Guarded: cannot delete if active sessions use it."""
    existing = agent_tools_store.get_by_id(tool_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"Agent tool {tool_id} not found") from None

    if agent_tools_store.has_active_sessions(existing["slug"]):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete '{existing['name']}': active sessions are using it",
        ) from None

    deleted = agent_tools_store.delete(tool_id)
    if not deleted:
        raise HTTPException(status_code=500, detail="Failed to delete agent tool") from None

    return {"deleted": True, "id": tool_id}
