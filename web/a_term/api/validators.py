"""Validation logic for API requests."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException


def validate_uuid(value: str) -> None:
    """Validate that a string is a valid UUID.

    Raises HTTPException(400) if invalid.
    """
    try:
        uuid.UUID(value)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid UUID") from None


def validate_pane_limit(current_count: int, max_panes: int) -> None:
    """Validate that pane count is under limit.

    Raises HTTPException if limit exceeded.
    """
    if current_count >= max_panes:
        raise HTTPException(
            status_code=400,
            detail=f"Maximum {max_panes} panes allowed. Close one to add more.",
        )


def validate_create_pane_request(pane_type: str, project_id: str | None) -> None:
    """Validate create pane request for type/project consistency.

    Raises HTTPException if validation fails.
    """
    if pane_type == "project" and not project_id:
        raise HTTPException(status_code=400, detail="project_id required for project panes")
    if pane_type == "adhoc" and project_id:
        raise HTTPException(status_code=400, detail="project_id must be empty for adhoc panes")


def validate_active_mode(
    pane_type: str,
    active_mode: str,
    available_modes: set[str] | None = None,
) -> None:
    """Validate active_mode is compatible with pane_type.

    Raises HTTPException if:
    - adhoc pane tries to use non-shell mode
    - project pane mode is not one of its existing session modes
    """
    if pane_type == "adhoc" and active_mode != "shell":
        raise HTTPException(status_code=400, detail="Ad-hoc panes only support shell mode") from None
    if pane_type == "project" and available_modes is not None and active_mode not in available_modes:
        raise HTTPException(
            status_code=400,
            detail=f"Mode '{active_mode}' not available on this pane",
        ) from None


def require_pane_exists(pane: dict[str, Any] | None, pane_id: str) -> dict[str, Any]:
    """Validate pane exists or raise 404.

    Returns the pane if it exists.
    """
    if not pane:
        raise HTTPException(status_code=404, detail=f"Pane {pane_id} not found")
    return pane
