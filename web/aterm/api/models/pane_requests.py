"""Pydantic request models for A-Term Panes API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class CreatePaneRequest(BaseModel):
    """Request to create a aterm pane."""

    pane_type: Literal["project", "adhoc"]
    pane_name: str
    project_id: str | None = None
    working_dir: str | None = None
    agent_tool_slug: str | None = Field(None, min_length=1, pattern=r"^[a-z0-9_-]+$")


class UpdatePaneRequest(BaseModel):
    """Request to update a aterm pane."""

    pane_name: str | None = None
    active_mode: str | None = None  # 'shell' or any agent tool slug


class SwitchAgentToolRequest(BaseModel):
    """Request to switch the agent tool on a pane."""

    agent_tool_slug: str = Field(..., min_length=1, pattern=r"^[a-z0-9_-]+$")


class SwapPanesRequest(BaseModel):
    """Request to swap two pane positions."""

    pane_id_a: str
    pane_id_b: str


class UpdatePaneOrderRequest(BaseModel):
    """Request to update pane ordering."""

    pane_orders: list[tuple[str, int]]  # [(pane_id, new_order), ...]
