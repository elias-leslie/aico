"""Diagnostics API routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..services.diagnostics import get_registry

router = APIRouter(prefix="/api/diagnostics", tags=["diagnostics"])


@router.get("/sessions")
async def list_diagnostic_sessions() -> dict:
    """List sessions with active diagnostics."""
    registry = get_registry()
    sessions = []
    for sid in registry.list_sessions():
        diag = registry.get(sid)
        if diag:
            sessions.append(diag.get_summary())
    return {"sessions": sessions}


@router.get("/sessions/{session_id}/events")
async def get_diagnostic_events(
    session_id: str,
    since: float = Query(0.0),
    limit: int = Query(500, ge=1, le=2000),
) -> dict:
    """Return recent diagnostic events for a session."""
    registry = get_registry()
    diag = registry.get(session_id)
    if diag is None:
        raise HTTPException(404, "No diagnostics for this session")
    return {"events": diag.get_events(since=since, limit=limit)}


@router.get("/sessions/{session_id}/summary")
async def get_diagnostic_summary(session_id: str) -> dict:
    """Return aggregated counters for a session."""
    registry = get_registry()
    diag = registry.get(session_id)
    if diag is None:
        raise HTTPException(404, "No diagnostics for this session")
    return diag.get_summary()


# ── Metrics endpoint (registered on main app, not here) ──

__all__ = ["router"]
