"""Internal maintenance endpoints (``/api/internal/maintenance*``): status, a manual run, recent runs.

Mounted on the ``internal`` surface: the caller-trust gate lets a request in only with the internal token
(``Authorization: Bearer <token>``, else ``?token=``; see ``a_term.caller_trust``). ``token`` stays a declared query
parameter so the API schema keeps it.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from ..services.maintenance import get_status as get_maintenance_status
from ..services.maintenance import list_recent_runs as list_recent_maintenance_runs
from ..services.maintenance import run_cycle as run_maintenance_cycle

router = APIRouter()


@router.get("/api/internal/maintenance", response_model=None)
async def maintenance_status(request: Request, token: str = Query("")) -> dict[str, Any]:
    """Return current maintenance status for operational verification."""
    return get_maintenance_status(request.app)


@router.post("/api/internal/maintenance/run", response_model=None)
async def run_maintenance(request: Request, token: str = Query("")) -> dict[str, Any]:
    """Trigger one immediate maintenance cycle."""
    return await run_maintenance_cycle(request.app, reason="manual")


@router.get("/api/internal/maintenance/runs", response_model=None)
async def maintenance_runs(
    request: Request,
    token: str = Query(""),
    limit: int = Query(10, ge=1, le=100),
) -> dict[str, Any]:
    """Return recent maintenance runs (kept in memory since startup)."""
    runs = list_recent_maintenance_runs(request.app, limit=limit)
    return {"items": runs, "total": len(runs)}
