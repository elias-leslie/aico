"""Aico FastAPI sidecar.

Loopback service for `/health`, local selection delivery, and per-widget
JSONL event logs.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from aico_sidecar import __version__
from aico_sidecar.config import Settings
from aico_sidecar.events import EventHub
from aico_sidecar.selection import RING_SIZE, SelectionBus
from aico_sidecar.widget_log import WidgetLog, is_valid_widget_id

# Serialized-JSON cap on a widget event's `data`, so a caller can't bypass the
# per-log rotation by flooding one oversized record.
WIDGET_EVENT_DATA_CAP = 8000

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("aico_sidecar")

router = APIRouter()

# Browser origins allowed to reach the bus over CORS: any loopback page (the DOM
# source on another localhost port) and the Aico extension. Replaces a bare "*"
# so a public website can't read selection state cross-origin.
_TRUSTED_ORIGIN_REGEX = r"^(chrome-extension://[A-Za-z0-9]+|https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?)$"


def _is_trusted_origin(origin: str | None) -> bool:
    """CSRF guard for the unauthenticated bus: state-changing POSTs are accepted
    only from native clients (no Origin header — Electron main, `st` CLI, curl),
    the browser extension, or local pages. A public website's fetch carries its
    own Origin and is rejected, so a visited page can't silently inject text into
    the active terminal. The Origin header is browser-set and unforgeable by page
    script, and a page cannot suppress it, so allowing the absent case is safe."""
    if origin is None:
        return True
    parts = urlsplit(origin)
    if parts.scheme == "chrome-extension":
        return True
    host = parts.hostname or ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


async def require_trusted_origin(request: Request) -> None:
    if not _is_trusted_origin(request.headers.get("origin")):
        raise HTTPException(status_code=403, detail="origin not allowed")


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str


class WidgetEvent(BaseModel):
    event: str = Field(min_length=1, max_length=200)
    data: dict[str, Any] = Field(default_factory=dict)

    @field_validator("data")
    @classmethod
    def _cap_data(cls, value: dict[str, Any]) -> dict[str, Any]:
        encoded = json.dumps(value, separators=(",", ":"))
        if len(encoded) > WIDGET_EVENT_DATA_CAP:
            raise ValueError(f"data too large: {len(encoded)} bytes (cap {WIDGET_EVENT_DATA_CAP})")
        return value


class WidgetEventResponse(BaseModel):
    logged: bool
    record: dict[str, Any]


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Basic liveness check. Returns 200 OK if the sidecar is running."""
    return HealthResponse(status="ok", service="aico-sidecar", version=__version__)


class SelectionIn(BaseModel):
    kind: str
    snippet: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)
    widget: str | None = None
    project: str | None = None


# NOTE: the bus/log handlers are sync `def` so Starlette runs their blocking
# SQLite/file I/O in its threadpool instead of stalling the event loop (and the
# SSE keepalive). SelectionBus serializes its one connection with a lock.
@router.post("/selection", dependencies=[Depends(require_trusted_origin)])
def push_selection(body: SelectionIn, request: Request) -> dict[str, Any]:
    """A source (DOM today) reports its current selection to the bus."""
    bus: SelectionBus = request.app.state.selection_bus
    try:
        return bus.push(body.kind, body.snippet, body.meta, body.widget, body.project)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/selection/current")
def selection_current(request: Request) -> dict[str, Any]:
    """The newest capture, or `{"kind": "empty"}` when the bus is empty."""
    bus: SelectionBus = request.app.state.selection_bus
    return bus.current() or {"kind": "empty"}


@router.get("/selection/history")
def selection_history(request: Request, n: int = Query(20, ge=1, le=RING_SIZE)) -> dict[str, Any]:
    """Up to `n` captures, newest first."""
    bus: SelectionBus = request.app.state.selection_bus
    items = bus.history(n)
    return {"items": items, "count": len(items)}


class SelectionBatchIn(BaseModel):
    items: list[SelectionIn] = Field(min_length=1)


@router.post("/selection/send", dependencies=[Depends(require_trusted_origin)])
async def send_selection(body: SelectionBatchIn, request: Request) -> dict[str, Any]:
    """Explicit send: store the capture(s) AND push a deliver event to Electron.

    The bare `POST /selection` is store-only (harvested by the global hotkey).
    This path is the gesture-driven one (browser pill / right-click / picker):
    it stores then emits, so the active widget gets the insert immediately.
    """
    bus: SelectionBus = request.app.state.selection_bus
    hub: EventHub = request.app.state.event_hub

    def push_all() -> list[dict[str, Any]]:
        return [
            bus.push(item.kind, item.snippet, item.meta, item.widget, item.project)
            for item in body.items
        ]

    try:
        # Offload the blocking SQLite writes; publish stays on the loop (the queues
        # are asyncio.Queue, not thread-safe, so they must be touched here).
        records = await run_in_threadpool(push_all)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    hub.publish({"records": records})
    return {"records": records, "count": len(records)}


@router.get("/selection/events")
async def selection_events(request: Request) -> StreamingResponse:
    """SSE stream of deliver events. Electron's main process subscribes here so a
    browser-side "send" reaches the tmux insert path. Keepalive comments every
    15s keep the connection live and surface client disconnects promptly."""
    hub: EventHub = request.app.state.event_hub

    async def gen() -> AsyncIterator[str]:
        q = hub.register()
        try:
            yield ": connected\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield f"data: {json.dumps(event, separators=(',', ':'))}\n\n"
        finally:
            hub.unregister(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/widgets/{widget_id}/events",
    response_model=WidgetEventResponse,
    dependencies=[Depends(require_trusted_origin)],
)
def log_widget_event(widget_id: str, body: WidgetEvent, request: Request) -> WidgetEventResponse:
    """Append a structured event to the widget's JSONL log."""
    if not is_valid_widget_id(widget_id):
        raise HTTPException(status_code=422, detail=f"invalid widget id: {widget_id!r}")
    widget_log: WidgetLog = request.app.state.widget_log
    record = widget_log.append(widget_id, body.event, body.data)
    logger.info("widget %s event %s", widget_id, body.event)
    return WidgetEventResponse(logged=True, record=record)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        logger.info("aico-sidecar %s starting; state_dir=%s", __version__, settings.state_dir)
        try:
            yield
        finally:
            app.state.selection_bus.close()

    app = FastAPI(title="aico-sidecar", version=__version__, lifespan=lifespan)
    # The DOM source posts from web apps served on other localhost origins, and the
    # extension posts from chrome-extension://. Restrict CORS to those (no bare "*")
    # so a public website can't read selection state cross-origin; state-changing
    # POSTs get the stricter server-side Origin check (require_trusted_origin).
    app.add_middleware(
        CORSMiddleware,  # type: ignore[invalid-argument-type]  # Starlette factory typing
        allow_origin_regex=_TRUSTED_ORIGIN_REGEX,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    app.state.settings = settings
    app.state.widget_log = WidgetLog(settings.logs_dir)
    app.state.selection_bus = SelectionBus(settings.selections_db)
    app.state.event_hub = EventHub()
    app.include_router(router)
    return app
