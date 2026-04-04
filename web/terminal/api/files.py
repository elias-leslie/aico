"""Terminal Files API - file upload endpoint.

Stores uploaded files server-side; returns path for use in terminal commands.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile
from pydantic import BaseModel

from ..config import MAX_FILE_SIZE, MAX_FILE_SIZE_MB, UPLOAD_DIR
from ..logging_config import get_logger
from ..rate_limit import limiter

logger = get_logger(__name__)
router = APIRouter(tags=["Terminal Files"])

ALLOWED_MIME_TYPES = {
    "image/png", "image/jpeg", "image/gif", "image/webp",
    "text/markdown", "text/plain", "application/json", "application/pdf",
}

MIME_TO_EXTENSION = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
    "image/webp": ".webp", "text/markdown": ".md", "text/plain": ".txt",
    "application/json": ".json", "application/pdf": ".pdf",
}

_MAGIC_SIGNATURES: dict[bytes, str] = {
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
    b"GIF87a": "image/gif",
    b"GIF89a": "image/gif",
    b"RIFF": "image/webp",
    b"%PDF": "application/pdf",
}

_TEXT_MIME_TYPES = {"text/markdown", "text/plain", "application/json"}


def _detect_mime_type(content: bytes, claimed_type: str) -> str | None:
    """Return detected MIME type from magic bytes, or None if unrecognised.

    Text types (markdown, plain, JSON) have no magic bytes — trust claimed_type.
    """
    if claimed_type in _TEXT_MIME_TYPES:
        return claimed_type
    for signature, mime_type in _MAGIC_SIGNATURES.items():
        if content[: len(signature)] == signature:
            if mime_type == "image/webp" and content[8:12] != b"WEBP":
                continue
            return mime_type
    return None


class FileUploadResponse(BaseModel):
    """Response for file upload."""

    path: str
    filename: str
    size: int
    mime_type: str


async def _read_file_content(file: UploadFile) -> bytes:
    """Read upload in 1 MB chunks, raising HTTP 413 if MAX_FILE_SIZE exceeded."""
    chunks: list[bytes] = []
    total_size = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total_size += len(chunk)
        if total_size > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Maximum size: {MAX_FILE_SIZE_MB}MB",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _validate_mime_type(content: bytes, claimed_type: str) -> str:
    """Validate claimed MIME type and confirm via magic bytes; return detected type."""
    if claimed_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"File type '{claimed_type}' not allowed. "
                f"Allowed: {', '.join(sorted(ALLOWED_MIME_TYPES))}"
            ),
        )
    detected = _detect_mime_type(content, claimed_type)
    if detected is None:
        raise HTTPException(
            status_code=400,
            detail=f"File content does not match claimed type '{claimed_type}'",
        )
    return detected


def _save_upload(content: bytes, content_type: str) -> tuple[str, str]:
    """Persist content to UPLOAD_DIR with a UUID filename; return (filename, shell_path).

    Returns a tilde-prefixed path (e.g., ~/terminal-uploads/abc.png) to avoid
    leaking the full server filesystem path to the client.
    """
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4()}{MIME_TO_EXTENSION.get(content_type, '')}"
    file_path = UPLOAD_DIR / filename
    file_path.write_bytes(content)
    # Return ~/relative path instead of absolute to avoid leaking home dir
    try:
        relative = file_path.relative_to(Path.home())
        shell_path = f"~/{relative}"
    except ValueError:
        shell_path = str(file_path)
    return filename, shell_path


@router.post("/api/terminal/files", response_model=FileUploadResponse)
@limiter.limit("10/minute")
async def upload_file(request: Request, file: UploadFile) -> FileUploadResponse:
    """Upload a file for use in terminal commands.

    Stores in ~/terminal-uploads/ with UUID naming.
    Allowed: png, jpg, gif, webp, md, txt, json, pdf. Max: 10 MB.
    """
    content = await _read_file_content(file)
    if not content:
        raise HTTPException(status_code=400, detail="Empty file not allowed")
    content_type = _validate_mime_type(content, file.content_type or "application/octet-stream")
    filename, file_path = _save_upload(content, content_type)
    logger.info(
        "file_uploaded",
        filename=filename,
        size=len(content),
        mime_type=content_type,
        original_name=file.filename,
    )
    return FileUploadResponse(
        path=file_path, filename=filename, size=len(content), mime_type=content_type
    )
