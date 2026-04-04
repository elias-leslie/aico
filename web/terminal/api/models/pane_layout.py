"""Pydantic layout models for Terminal Panes API."""

from __future__ import annotations

from pydantic import BaseModel


class UpdatePaneLayoutRequest(BaseModel):
    """Request to update a single pane's layout."""

    width_percent: float | None = None
    height_percent: float | None = None
    grid_row: int | None = None
    grid_col: int | None = None


class PaneLayoutItem(BaseModel):
    """Single pane layout for bulk update."""

    pane_id: str
    width_percent: float | None = None
    height_percent: float | None = None
    grid_row: int | None = None
    grid_col: int | None = None


class BulkLayoutUpdateRequest(BaseModel):
    """Request to update layout for all panes at once."""

    layouts: list[PaneLayoutItem]
