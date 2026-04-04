"""Pydantic response models for Terminal Panes API."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class SessionInPaneResponse(BaseModel):
    """Session data within a pane response."""

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    mode: str
    session_number: int
    is_alive: bool
    working_dir: str | None
    claude_state: str = "not_started"


class PaneResponse(BaseModel):
    """Terminal pane response model."""

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
    """Response for listing terminal panes."""

    items: list[PaneResponse]
    total: int
    max_panes: int
