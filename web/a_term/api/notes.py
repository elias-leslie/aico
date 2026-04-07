"""Notes API for A-Term.

Uses local storage in standalone mode and proxies the same contract to
SummitFlow when the companion API is configured.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Body, HTTPException, Request, Response
from pydantic import BaseModel

from ..services import project_catalog, summitflow_client
from ..storage import note_versions
from ..storage import notes as note_store

router = APIRouter(tags=["Notes"])

_EDIT_VERSION_FIELDS = {"title", "content", "tags"}
_EDIT_CHECKPOINT_COOLDOWN = timedelta(minutes=5)


class NoteResponse(BaseModel):
    id: str
    project_scope: str
    type: str
    title: str
    content: str
    tags: list[str]
    pinned: bool
    metadata: dict[str, Any]
    created_at: str | None
    updated_at: str | None


class CreateNoteRequest(BaseModel):
    title: str
    content: str = ""
    project_scope: str = "global"
    type: Literal["note", "prompt"] = "note"
    tags: list[str] = []
    pinned: bool = False
    metadata: dict[str, Any] | None = None


class UpdateNoteRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    project_scope: str | None = None
    type: Literal["note", "prompt"] | None = None
    tags: list[str] | None = None
    pinned: bool | None = None
    metadata: dict[str, Any] | None = None


class VersionResponse(BaseModel):
    id: str
    note_id: str
    version: int
    title: str
    content: str
    tags: list[str]
    change_source: str
    created_at: str | None


class NotesCapabilitiesResponse(BaseModel):
    title_generation: bool
    formatting: bool
    prompt_refinement: bool


class NotesScopeOptionResponse(BaseModel):
    value: str
    label: str
    known: bool


_LOCAL_CAPABILITIES = NotesCapabilitiesResponse(
    title_generation=True,
    formatting=False,
    prompt_refinement=False,
)


def _iso(dt: Any) -> str | None:
    return dt.isoformat() if dt else None


def _normalize_tags(tags: list[str] | None) -> list[str]:
    return tags or []


def _build_scope_options(
    projects: list[dict[str, Any]],
    observed_scopes: list[str],
) -> list[NotesScopeOptionResponse]:
    options = [
        NotesScopeOptionResponse(value="global", label="Global", known=True),
    ]
    seen = {"global"}

    for project in sorted(projects, key=lambda item: str(item.get("name") or item.get("id") or "").lower()):
        project_id = str(project.get("id") or "").strip()
        if not project_id or project_id in seen:
            continue
        label = str(project.get("name") or project_id).strip() or project_id
        seen.add(project_id)
        options.append(
            NotesScopeOptionResponse(value=project_id, label=label, known=True)
        )

    for scope in observed_scopes:
        normalized = str(scope or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        options.append(
            NotesScopeOptionResponse(
                value=normalized,
                label=normalized,
                known=False,
            )
        )

    return options


def _note_state_matches(
    snapshot: dict[str, Any], *, title: str, content: str, tags: list[str] | None
) -> bool:
    return (
        snapshot["title"] == title
        and snapshot["content"] == content
        and _normalize_tags(snapshot.get("tags")) == _normalize_tags(tags)
    )


def _has_meaningful_note_changes(existing: dict[str, Any], fields: dict[str, Any]) -> bool:
    if not _EDIT_VERSION_FIELDS.intersection(fields):
        return False
    next_title = fields.get("title", existing["title"])
    next_content = fields.get("content", existing["content"])
    next_tags = fields.get("tags", existing.get("tags", []))
    return not _note_state_matches(
        existing,
        title=next_title,
        content=next_content,
        tags=next_tags,
    )


def _within_edit_checkpoint_window(created_at: Any) -> bool:
    if not isinstance(created_at, datetime):
        return False
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=UTC)
    return created_at >= datetime.now(tz=UTC) - _EDIT_CHECKPOINT_COOLDOWN


def _maybe_create_edit_checkpoint(note_id: str, existing: dict[str, Any], fields: dict[str, Any]) -> None:
    if not _has_meaningful_note_changes(existing, fields):
        return

    latest = note_versions.get_latest_version(note_id)
    if latest and _note_state_matches(
        latest,
        title=existing["title"],
        content=existing["content"],
        tags=existing.get("tags", []),
    ):
        return
    if latest and _within_edit_checkpoint_window(latest.get("created_at")):
        return

    note_versions.create_version(
        note_id=note_id,
        title=existing["title"],
        content=existing["content"],
        tags=existing.get("tags", []),
        change_source="edit_checkpoint",
    )


def _get_note_or_404(note_id: str) -> dict[str, Any]:
    note = note_store.get_note(note_id)
    if not note:
        raise HTTPException(status_code=404, detail=f"Note {note_id} not found")
    return note


def _note_to_response(note: dict[str, Any]) -> NoteResponse:
    return NoteResponse(
        id=note["id"],
        project_scope=note["project_scope"],
        type=note["type"],
        title=note["title"],
        content=note["content"],
        tags=note.get("tags", []),
        pinned=note["pinned"],
        metadata=note.get("metadata", {}),
        created_at=_iso(note.get("created_at")),
        updated_at=_iso(note.get("updated_at")),
    )


def _version_to_response(version: dict[str, Any]) -> VersionResponse:
    return VersionResponse(
        id=version["id"],
        note_id=version["note_id"],
        version=version["version"],
        title=version["title"],
        content=version["content"],
        tags=version.get("tags", []),
        change_source=version["change_source"],
        created_at=_iso(version.get("created_at")),
    )


def _extract_title(content: str) -> str:
    for raw_line in content.splitlines():
        line = " ".join(raw_line.strip().split())
        if 5 < len(line) <= 120:
            return line.strip("#*-`'\" ")
    cleaned = " ".join(content.strip().split())
    return cleaned[:120]


def _is_remote_mode() -> bool:
    return summitflow_client.has_companion_api()


async def _proxy_notes_request(request: Request, path: str) -> Response:
    response = await summitflow_client.api_request(
        request.method,
        f"/notes{path}",
        params=list(request.query_params.multi_items()),
        content=await request.body(),
        headers={
            key: value
            for key, value in request.headers.items()
            if key.lower() in {"content-type", "accept"}
        },
    )
    proxied = Response(content=response.content, status_code=response.status_code)
    content_type = response.headers.get("content-type")
    if content_type:
        proxied.headers["content-type"] = content_type
    return proxied


@router.get("/api/notes/capabilities", response_model=NotesCapabilitiesResponse)
async def get_notes_capabilities(request: Request) -> NotesCapabilitiesResponse | Response:
    if _is_remote_mode():
        return await _proxy_notes_request(request, "/capabilities")
    return _LOCAL_CAPABILITIES


@router.get("/api/notes/scopes", response_model=list[NotesScopeOptionResponse])
async def get_scopes(request: Request):
    if _is_remote_mode():
        return await _proxy_notes_request(request, "/scopes")
    return _build_scope_options(
        await project_catalog.list_projects(),
        note_store.list_project_scopes(),
    )


@router.get("/api/notes/tags", response_model=None)
async def get_tags(
    request: Request,
    project_scope: str | None = None,
):
    if _is_remote_mode():
        return await _proxy_notes_request(request, "/tags")
    return {"tags": note_store.list_tags(project_scope)}


@router.get("/api/notes", response_model=None)
async def list_notes(
    request: Request,
    project_scope: str | None = None,
    type: Literal["note", "prompt"] | None = None,
    tag: list[str] | None = None,
    search: str | None = None,
    pinned: bool | None = None,
    limit: int = 50,
    offset: int = 0,
):
    if _is_remote_mode():
        return await _proxy_notes_request(request, "")
    items = note_store.list_notes(
        project_scope=project_scope,
        note_type=type,
        tags=tag,
        search=search,
        pinned=pinned,
        limit=limit,
        offset=offset,
    )
    total = note_store.count_notes(
        project_scope=project_scope,
        note_type=type,
        tags=tag,
        search=search,
        pinned=pinned,
    )
    return {"items": [_note_to_response(note) for note in items], "total": total}


@router.get("/api/notes/{note_id}", response_model=NoteResponse)
async def get_note(request: Request, note_id: str) -> NoteResponse | Response:
    if _is_remote_mode():
        return await _proxy_notes_request(request, f"/{note_id}")
    return _note_to_response(_get_note_or_404(note_id))


@router.post("/api/notes", response_model=NoteResponse, status_code=201)
async def create_note(request: Request, payload: CreateNoteRequest) -> NoteResponse | Response:
    if _is_remote_mode():
        return await _proxy_notes_request(request, "")
    note = note_store.create_note(
        title=payload.title,
        content=payload.content,
        project_scope=payload.project_scope,
        note_type=payload.type,
        tags=payload.tags,
        pinned=payload.pinned,
        metadata=payload.metadata,
    )
    return _note_to_response(note)


@router.patch("/api/notes/{note_id}", response_model=NoteResponse)
async def update_note(
    request: Request,
    note_id: str,
    payload: UpdateNoteRequest,
) -> NoteResponse | Response:
    if _is_remote_mode():
        return await _proxy_notes_request(request, f"/{note_id}")
    existing = _get_note_or_404(note_id)
    fields = {key: value for key, value in payload.model_dump().items() if value is not None}
    _maybe_create_edit_checkpoint(note_id, existing, fields)
    note = note_store.update_note(note_id, **fields)
    if not note:
        raise HTTPException(status_code=500, detail="Failed to update note")
    return _note_to_response(note)


@router.delete("/api/notes/{note_id}", response_model=None)
async def delete_note(request: Request, note_id: str):
    if _is_remote_mode():
        return await _proxy_notes_request(request, f"/{note_id}")
    _get_note_or_404(note_id)
    if not note_store.delete_note(note_id):
        raise HTTPException(status_code=500, detail="Failed to delete note")
    return {"deleted": True, "id": note_id}


@router.post("/api/notes/generate-title", response_model=None)
async def generate_title(
    request: Request,
    content: str = Body(..., embed=True),
):
    if _is_remote_mode():
        return await _proxy_notes_request(request, "/generate-title")
    if len(content.strip()) < 20:
        raise HTTPException(status_code=400, detail="Content too short")
    title = _extract_title(content)
    if not title:
        raise HTTPException(status_code=400, detail="Unable to generate title")
    return {"title": title}


@router.post("/api/notes/format", response_model=None, status_code=501)
async def format_note(request: Request):
    if _is_remote_mode():
        return await _proxy_notes_request(request, "/format")
    raise HTTPException(status_code=501, detail="Formatting is unavailable in standalone A-Term notes")


@router.post("/api/notes/refine-prompt", response_model=None, status_code=501)
async def refine_prompt(request: Request):
    if _is_remote_mode():
        return await _proxy_notes_request(request, "/refine-prompt")
    raise HTTPException(status_code=501, detail="Prompt refinement is unavailable in standalone A-Term notes")


@router.get("/api/notes/{note_id}/format-proposal", response_model=None)
async def get_format_proposal(
    request: Request,
    note_id: str,
):
    if _is_remote_mode():
        return await _proxy_notes_request(request, f"/{note_id}/format-proposal")
    _get_note_or_404(note_id)
    return None


@router.post("/api/notes/format-proposals/{proposal_id}/resolve", response_model=None, status_code=501)
async def resolve_format_proposal(
    request: Request,
    proposal_id: str,
    action: str = Body(..., embed=True),
):
    if _is_remote_mode():
        return await _proxy_notes_request(request, f"/format-proposals/{proposal_id}/resolve")
    raise HTTPException(
        status_code=501,
        detail="Formatting proposals are unavailable in standalone A-Term notes",
    )


@router.get("/api/notes/{note_id}/versions", response_model=list[VersionResponse])
async def list_versions(request: Request, note_id: str) -> list[VersionResponse] | Response:
    if _is_remote_mode():
        return await _proxy_notes_request(request, f"/{note_id}/versions")
    _get_note_or_404(note_id)
    return [_version_to_response(version) for version in note_versions.list_versions(note_id)]


@router.post("/api/notes/{note_id}/versions", response_model=VersionResponse, status_code=201)
async def create_version_endpoint(request: Request, note_id: str) -> VersionResponse | Response:
    if _is_remote_mode():
        return await _proxy_notes_request(request, f"/{note_id}/versions")
    existing = _get_note_or_404(note_id)
    version = note_versions.create_version(
        note_id=note_id,
        title=existing["title"],
        content=existing["content"],
        tags=existing.get("tags", []),
        change_source="manual_snapshot",
    )
    return _version_to_response(version)


@router.get("/api/notes/versions/{version_id}", response_model=VersionResponse)
async def get_version(request: Request, version_id: str) -> VersionResponse | Response:
    if _is_remote_mode():
        return await _proxy_notes_request(request, f"/versions/{version_id}")
    version = note_versions.get_version(version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    return _version_to_response(version)


@router.post("/api/notes/{note_id}/revert/{version_id}", response_model=NoteResponse)
async def revert_to_version(
    request: Request,
    note_id: str,
    version_id: str,
) -> NoteResponse | Response:
    if _is_remote_mode():
        return await _proxy_notes_request(request, f"/{note_id}/revert/{version_id}")

    existing = _get_note_or_404(note_id)
    version = note_versions.get_version(version_id)
    if not version or version["note_id"] != note_id:
        raise HTTPException(
            status_code=404,
            detail=f"Version {version_id} not found for note {note_id}",
        )

    note_versions.create_version(
        note_id=note_id,
        title=existing["title"],
        content=existing["content"],
        tags=existing.get("tags", []),
        change_source="pre_revert",
    )
    note = note_store.update_note(
        note_id,
        title=version["title"],
        content=version["content"],
        tags=version["tags"],
    )
    if not note:
        raise HTTPException(status_code=500, detail="Failed to revert note")
    note_versions.create_version(
        note_id=note_id,
        title=version["title"],
        content=version["content"],
        tags=version["tags"],
        change_source="revert",
    )
    return _note_to_response(note)
