"""Response builders for A-Term Panes API."""

from __future__ import annotations

from typing import Any

from .models.pane_responses import PaneResponse, SessionInPaneResponse


def build_pane_response(pane: dict[str, Any]) -> PaneResponse:
    """Convert storage pane dict to API response."""
    sessions = [
        {
            **session,
            "agent_state": session.get("agent_state") or session.get("claude_state") or "not_started",
            "claude_state": session.get("claude_state") or session.get("agent_state") or "not_started",
        }
        for session in pane.get("sessions", [])
    ]
    return PaneResponse(
        id=pane["id"],
        pane_type=pane["pane_type"],
        project_id=pane.get("project_id"),
        pane_order=pane["pane_order"],
        pane_name=pane["pane_name"],
        active_mode=pane.get("active_mode", "shell"),
        is_detached=bool(pane.get("is_detached", False)),
        created_at=pane["created_at"].isoformat() if pane.get("created_at") else None,
        sessions=[SessionInPaneResponse.model_validate(s) for s in sessions],
        width_percent=pane.get("width_percent", 100.0),
        height_percent=pane.get("height_percent", 100.0),
        grid_row=pane.get("grid_row", 0),
        grid_col=pane.get("grid_col", 0),
    )
