"""Diagnostics and recording API routes."""

from __future__ import annotations

import contextlib
import json

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


# ── Recording endpoints ──


@router.get("/recordings")
async def list_recordings(session_id: str | None = Query(None)) -> dict:
    """List recording files, optionally filtered by session_id."""
    from ..config import get_settings

    settings = get_settings()
    recording_dir = settings.recording_dir
    if not recording_dir.is_dir():
        return {"recordings": []}

    recordings = []
    for path in sorted(recording_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
        if session_id and not path.name.startswith(session_id):
            continue
        stat = path.stat()
        recordings.append({
            "file": path.name,
            "size_bytes": stat.st_size,
            "modified": stat.st_mtime,
        })
    return {"recordings": recordings}


@router.get("/recordings/{filename}/events")
async def get_recording_events(
    filename: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(1000, ge=1, le=5000),
) -> dict:
    """Stream events from a recording file."""
    from ..config import get_settings

    settings = get_settings()
    file_path = settings.recording_dir / filename
    if not file_path.is_file() or ".." in filename:
        raise HTTPException(404, "Recording not found")

    events = []
    line_no = 0
    with file_path.open(encoding="utf-8") as f:
        for line in f:
            if line_no < offset:
                line_no += 1
                continue
            if len(events) >= limit:
                break
            with contextlib.suppress(json.JSONDecodeError):
                events.append(json.loads(line))
            line_no += 1
    return {"events": events, "offset": offset, "count": len(events)}


@router.delete("/recordings/{filename}")
async def delete_recording(filename: str) -> dict:
    """Delete a recording file."""
    from ..config import get_settings

    settings = get_settings()
    file_path = settings.recording_dir / filename
    if not file_path.is_file() or ".." in filename:
        raise HTTPException(404, "Recording not found")
    file_path.unlink()
    return {"deleted": filename}


# ── Metrics endpoint (registered on main app, not here) ──

__all__ = ["router"]
