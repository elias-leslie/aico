"""Pydantic response models for A-Term Panes API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, model_validator


class SessionInPaneResponse(BaseModel):
    """Session data within a pane response."""

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    mode: str
    session_number: int
    is_alive: bool
    working_dir: str | None
    agent_state: str = "not_started"
    claude_state: str = "not_started"

    @model_validator(mode="before")
    @classmethod
    def populate_agent_state(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values
        agent_state = values.get("agent_state") or values.get("claude_state") or "not_started"
        return {
            **values,
            "agent_state": agent_state,
            "claude_state": values.get("claude_state") or agent_state,
        }


class PaneResponse(BaseModel):
    """A-Term pane response model."""

    id: str
    pane_type: str  # 'project' or 'adhoc'
    project_id: str | None
    pane_order: int
    pane_name: str
    active_mode: str  # 'shell' or agent tool slug
    is_detached: bool = False
    created_at: str | None
    sessions: list[SessionInPaneResponse] = []
    # Layout fields for resizable grid
    width_percent: float = 100.0
    height_percent: float = 100.0
    grid_row: int = 0
    grid_col: int = 0


class PaneListResponse(BaseModel):
    """Response for listing a_term panes."""

    items: list[PaneResponse]
    total: int
    max_panes: int
