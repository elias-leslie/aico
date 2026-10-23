"""Authenticated metadata and safe downloads for agent handoffs."""

from __future__ import annotations

import os
import stat
from collections.abc import Iterator
from typing import BinaryIO

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from ..config import get_settings
from ..services import shows

router = APIRouter()
MAX_SHOW_BYTES = 25 * 1024 * 1024


@router.get("/api/a-term/shows")
def recent_shows(response: Response, since: str | None = None) -> dict[str, list[dict[str, str | None]]]:
    response.headers["Cache-Control"] = "no-store"
    return {"shows": [show.metadata() for show in shows.store.recent(since)]}


def _open_file(name: str) -> BinaryIO:
    root = get_settings().tether_exchange_root
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Pin each directory by descriptor: no agent-controlled parent can redirect a read.
        parts = ["agent", *name.split("/")]
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise HTTPException(404, "Shared file unavailable")
    except BaseException:
        os.close(fd)
        raise
    return os.fdopen(fd, "rb")


def _image_type(header: bytes) -> str | None:
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "image/webp"
    return None


@router.get("/api/a-term/shows/{show_id}/file")
def show_file(show_id: str) -> StreamingResponse:
    show = shows.store.get(show_id)
    if show is None or show.kind != "file":
        raise HTTPException(404, "Shared file not found")
    try:
        stream = _open_file(show.name)
    except OSError as error:
        raise HTTPException(404, "Shared file unavailable") from error
    try:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise HTTPException(404, "Shared file unavailable")
        if info.st_size > MAX_SHOW_BYTES:
            raise HTTPException(413, "Shared file exceeds 25 MB")
        image_type = _image_type(stream.read(16))
        stream.seek(0)
    except BaseException:
        stream.close()
        raise

    def chunks() -> Iterator[bytes]:
        with stream:
            # Bound reads by the checked size even if the agent grows the file meanwhile.
            remaining = info.st_size
            while remaining > 0:
                chunk = stream.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    disposition = "inline" if image_type else "attachment"
    filename = show.name.rsplit("/", 1)[-1]
    return StreamingResponse(
        chunks(),
        media_type=image_type or "application/octet-stream",
        headers={
            "Content-Disposition": f'{disposition}; filename="{filename}"',
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
        background=BackgroundTask(stream.close),
    )
