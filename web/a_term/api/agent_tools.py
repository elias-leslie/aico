"""Agent tools API: A-Term's view of Tether's merged tool registry.

Edits here change launches in Aico too. ``{tool_ref}`` is a tool id, slug or
alias. Slugs are immutable; ``command`` must be plain words (Tether stores it
as argv), and an empty command is the bare login shell.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services import agent_tools as tools_service
from ..services.tether_errors import to_http_error
from ..tether import TetherError, TetherUnavailable

router = APIRouter(tags=["Agent Tools"])

_SLUG = r"^[a-z0-9_-]+$"


class AgentToolResponse(BaseModel):
    id: str
    slug: str
    name: str
    command: str
    argv: list[str] = []
    process_name: str = ""
    description: str | None = None
    color: str | None = None
    display_order: int = 0
    is_default: bool = False
    enabled: bool = True
    aliases: list[str] = []
    context_hook: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class CreateAgentToolRequest(BaseModel):
    slug: str = Field(max_length=50, pattern=_SLUG)
    name: str = Field(max_length=100)
    command: str = Field(default="", max_length=4096)
    process_name: str | None = Field(default=None, max_length=100)
    description: str | None = None
    color: str | None = Field(default=None, max_length=20)
    display_order: int | None = None
    is_default: bool | None = None
    enabled: bool | None = None
    aliases: list[str] | None = None


class UpdateAgentToolRequest(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    command: str | None = Field(default=None, max_length=4096)
    process_name: str | None = Field(default=None, max_length=100)
    description: str | None = None
    color: str | None = Field(default=None, max_length=20)
    display_order: int | None = None
    is_default: bool | None = None
    enabled: bool | None = None
    aliases: list[str] | None = None


def _validate_aliases(aliases: list[str] | None) -> None:
    for alias in aliases or []:
        if not re.fullmatch(_SLUG, alias) or len(alias) > 50:
            raise HTTPException(status_code=400, detail=f"Invalid alias '{alias[:50]}'")


@router.get("/api/a-term/agent-tools", response_model=list[AgentToolResponse])
def list_agent_tools(enabled_only: bool = False) -> list[AgentToolResponse]:
    try:
        return [AgentToolResponse.model_validate(tool) for tool in tools_service.list_tools(enabled_only=enabled_only)]
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error) from None


@router.get("/api/a-term/agent-tools/{tool_ref}", response_model=AgentToolResponse)
def get_agent_tool(tool_ref: str) -> AgentToolResponse:
    try:
        return AgentToolResponse.model_validate(tools_service.get_tool(tool_ref))
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error, not_found=f"Agent tool {tool_ref} not found") from None


@router.post("/api/a-term/agent-tools", response_model=AgentToolResponse, status_code=201)
def create_agent_tool(body: CreateAgentToolRequest) -> AgentToolResponse:
    _validate_aliases(body.aliases)
    fields: dict[str, Any] = body.model_dump(exclude_none=True)
    try:
        return AgentToolResponse.model_validate(tools_service.create_tool(fields))
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error) from None


@router.patch("/api/a-term/agent-tools/{tool_ref}", response_model=AgentToolResponse)
def update_agent_tool(tool_ref: str, body: UpdateAgentToolRequest) -> AgentToolResponse:
    _validate_aliases(body.aliases)
    fields = body.model_dump(exclude_unset=True)
    # name/command/flags cannot be cleared; description and color can.
    fields = {key: value for key, value in fields.items() if value is not None or key in {"description", "color"}}
    try:
        if not fields:
            return AgentToolResponse.model_validate(tools_service.get_tool(tool_ref))
        return AgentToolResponse.model_validate(tools_service.update_tool(tool_ref, fields))
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error, not_found=f"Agent tool {tool_ref} not found") from None


@router.delete("/api/a-term/agent-tools/{tool_ref}")
def delete_agent_tool(tool_ref: str) -> dict[str, Any]:
    try:
        tool = tools_service.get_tool(tool_ref)
        tools_service.delete_tool(tool_ref)
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error, not_found=f"Agent tool {tool_ref} not found") from None
    return {"deleted": True, "id": tool["id"], "slug": tool["slug"]}
