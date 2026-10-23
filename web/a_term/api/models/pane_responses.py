"""Pydantic response models for A-Term Panes API."""

from __future__ import annotations

from pydantic import BaseModel

from .session_responses import ATermSessionResponse

# A pane's sessions are full catalog sessions: the same model as the Sessions API.
SessionInPaneResponse = ATermSessionResponse


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
