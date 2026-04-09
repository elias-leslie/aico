"""Pane-scoped file browser API."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import file_browser
from ..storage import panes as pane_store
from .validators import require_pane_exists, validate_uuid

router = APIRouter(tags=["A-Term Files"])


class FileTreeEntryResponse(BaseModel):
    name: str
    path: str
    is_directory: bool
    size: int | None = None
    extension: str | None = None
    children_count: int | None = None


class FileTreeResponse(BaseModel):
    entries: list[FileTreeEntryResponse]
    path: str
    total: int


class FileContentResponse(BaseModel):
    path: str
    name: str
    content: str | None
    size: int
    lines: int
    extension: str | None
    is_binary: bool
    language: str | None
    truncated: bool


def _resolve_pane_root(pane_id: str) -> str:
    pane = require_pane_exists(pane_store.get_pane_with_sessions(pane_id), pane_id)

    shell_session = next(
        (
            session
            for session in pane.get("sessions", [])
            if session.get("mode") == "shell" and session.get("working_dir")
        ),
        None,
    )
    active_session = next(
        (
            session
            for session in pane.get("sessions", [])
            if session.get("mode") == pane.get("active_mode") and session.get("working_dir")
        ),
        None,
    )
    fallback_session = next(
        (session for session in pane.get("sessions", []) if session.get("working_dir")),
        None,
    )
    working_dir = (
        (shell_session or {}).get("working_dir")
        or (active_session or {}).get("working_dir")
        or (fallback_session or {}).get("working_dir")
    )
    if not working_dir:
        raise HTTPException(status_code=400, detail="Pane has no working directory")

    root = Path(working_dir).expanduser()
    if not root.exists():
        raise HTTPException(status_code=404, detail="Pane working directory does not exist")
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="Pane working directory is not a directory")
    return str(root.resolve())


def _translate_file_error(err: Exception) -> HTTPException:
    if isinstance(err, PermissionError):
        return HTTPException(status_code=403, detail=str(err))
    if isinstance(err, ValueError):
        return HTTPException(status_code=400, detail=str(err))
    if isinstance(err, FileNotFoundError):
        return HTTPException(status_code=404, detail=str(err))
    return HTTPException(status_code=500, detail="Failed to browse pane files")


@router.get("/api/a-term/panes/{pane_id}/files/tree", response_model=FileTreeResponse)
async def get_pane_file_tree(
    pane_id: str,
    path: str = "",
) -> FileTreeResponse:
    validate_uuid(pane_id)
    root = _resolve_pane_root(pane_id)
    try:
        data = file_browser.list_directory(root, path)
    except Exception as err:
        raise _translate_file_error(err) from None
    return FileTreeResponse.model_validate(data)


@router.get("/api/a-term/panes/{pane_id}/files/content", response_model=FileContentResponse)
async def get_pane_file_content(
    pane_id: str,
    path: str,
) -> FileContentResponse:
    validate_uuid(pane_id)
    root = _resolve_pane_root(pane_id)
    try:
        data = file_browser.read_file(root, path)
    except Exception as err:
        raise _translate_file_error(err) from None
    return FileContentResponse.model_validate(data)
