"""Internal maintenance endpoints (``/api/internal/maintenance*``): status, a manual run, recent runs.

Mounted on the ``internal`` surface: they need the internal token (see ``a_term.caller_trust``).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from ..services.maintenance import get_status as get_maintenance_status
from ..services.maintenance import list_recent_runs as list_recent_maintenance_runs
from ..services.maintenance import run_cycle as run_maintenance_cycle
from .handlers.internal_auth import require_internal_token

router = APIRouter()


@router.get("/api/internal/maintenance", response_model=None)
async def maintenance_status(request: Request, token: str = Query("")) -> dict[str, Any]:
    """Return current maintenance status for operational verification."""
    require_internal_token(request, token)
    return get_maintenance_status(request.app)


@router.post("/api/internal/maintenance/run", response_model=None)
async def run_maintenance(request: Request, token: str = Query("")) -> dict[str, Any]:
    """Trigger one immediate maintenance cycle."""
    require_internal_token(request, token)
    return await run_maintenance_cycle(request.app, reason="manual")


@router.get("/api/internal/maintenance/runs", response_model=None)
async def maintenance_runs(
    request: Request,
    token: str = Query(""),
    limit: int = Query(10, ge=1, le=100),
) -> dict[str, Any]:
    """Return recent maintenance runs (kept in memory since startup)."""
    require_internal_token(request, token)
    runs = list_recent_maintenance_runs(request.app, limit=limit)
    return {"items": runs, "total": len(runs)}
