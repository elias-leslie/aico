"""Aico FastAPI sidecar.

Loopback service for `/health`, local selection delivery, and per-widget
JSONL event logs.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import re
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from starlette import status
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from aico_sidecar import __version__
from aico_sidecar.config import Settings
from aico_sidecar.events import EventHub
from aico_sidecar.selection import META_CAP, RING_SIZE, SelectionBus, SelectionKind
from aico_sidecar.widget_log import WidgetLog, is_valid_widget_id

# Serialized-JSON cap on a widget event's `data`, so a caller can't bypass the
# per-log rotation by flooding one oversized record.
WIDGET_EVENT_DATA_CAP = 8000

# Whole-request body cap. A full /selection/send batch (RING_SIZE items, each
# with capped meta and a source-capped snippet) fits comfortably; anything
# bigger is rejected before it is buffered and parsed.
MAX_BODY_BYTES = 1024 * 1024

# Cap on the free-form widget/project labels a capture can carry.
LABEL_CAP = 200

# Host header names the loopback sidecar answers to, besides loopback IP
# literals. Checking Host defeats DNS rebinding: a public site that re-points
# its own name at 127.0.0.1 still sends `Host: evil.example`, so it can't read
# selection state same-origin.
_LOOPBACK_HOSTNAMES = frozenset({"localhost"})

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("aico_sidecar")

router = APIRouter()

def _trusted_origin_regex(extension_ids: Iterable[str]) -> str:
    """Browser origins allowed to reach the bus over CORS: any loopback page (the
    DOM source on another localhost port) and the pinned Aico extension ID(s).
    Replaces a bare "*" so a public website can't read selection state
    cross-origin, and pins the extension so another installed extension can't."""
    ids = "|".join(re.escape(ext_id) for ext_id in sorted(extension_ids))
    return rf"^(chrome-extension://({ids})|https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?)$"


def _is_allowed_host(host_header: str | None, port: int) -> bool:
    """True if a Host header names the loopback sidecar: localhost or a loopback
    IP literal (127.0.0.0/8, [::1]), bare or with the configured port. Any
    loopback bind host the config accepts is reachable; an IP literal needs no
    DNS, so it cannot be rebound."""
    if not host_header:
        return False
    try:
        parts = urlsplit(f"//{host_header}")
        host_port = parts.port
    except ValueError:
        return False
    if parts.hostname not in _LOOPBACK_HOSTNAMES:
        try:
            if not ipaddress.ip_address(parts.hostname or "").is_loopback:
                return False
        except ValueError:
            return False
    return host_port is None or host_port == port


class HostGuardMiddleware:
    """Reject requests whose Host header isn't a loopback name (DNS rebinding
    guard). Pure ASGI so it never buffers the SSE stream. Skipped when the
    operator opted into a remote bind (AICO_SIDECAR_ALLOW_REMOTE=1), since remote
    clients then legitimately address the sidecar by a LAN name or IP."""

    def __init__(self, app: ASGIApp, port: int, allow_remote: bool) -> None:
        self.app = app
        self.port = port
        self.allow_remote = allow_remote

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket") and not self.allow_remote:
            host = dict(scope.get("headers") or []).get(b"host")
            if not _is_allowed_host(host.decode("latin-1") if host else None, self.port):
                if scope["type"] == "websocket":
                    # Closing before accept makes the server refuse the handshake (403).
                    await WebSocketClose(code=status.WS_1008_POLICY_VIOLATION)(scope, receive, send)
                else:
                    await JSONResponse({"detail": "host not allowed"}, status_code=403)(
                        scope, receive, send
                    )
                return
        await self.app(scope, receive, send)


class _BodyTooLarge(HTTPException):
    """Raised mid-stream from the wrapped `receive`. An HTTPException so FastAPI's
    body reader re-raises it (it maps other errors to 400) and the app's
    exception handler renders the 413."""

    def __init__(self) -> None:
        super().__init__(status_code=413, detail="request body too large")


class BodyLimitMiddleware:
    """Reject request bodies over `max_bytes` with 413: up front from
    Content-Length, and while streaming for chunked bodies without one."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        too_large = JSONResponse({"detail": "request body too large"}, status_code=413)
        length = dict(scope.get("headers") or []).get(b"content-length")
        if length is not None:
            try:
                declared = int(length)
            except ValueError:
                declared = -1
            if declared < 0 or declared > self.max_bytes:
                await too_large(scope, receive, send)
                return

        received = 0
        started = False

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise _BodyTooLarge()
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _BodyTooLarge:
            if started:
                raise
            await too_large(scope, receive, send)


def _is_trusted_origin(origin: str | None, extension_ids: Iterable[str]) -> bool:
    """CSRF guard for the unauthenticated bus: state-changing POSTs are accepted
    only from native clients (no Origin header — Electron main, `st` CLI, curl),
    the browser extension, or local pages. A public website's fetch carries its
    own Origin and is rejected, so a visited page can't silently inject text into
    the active terminal. The Origin header is browser-set and unforgeable by page
    script, and a page cannot suppress it, so allowing the absent case is safe.
    Extension origins must carry a pinned extension ID, so another installed
    extension can't inject either."""
    if origin is None:
        return True
    parts = urlsplit(origin)
    if parts.scheme == "chrome-extension":
        return parts.netloc in extension_ids
    host = parts.hostname or ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


async def require_trusted_origin(request: Request) -> None:
    settings: Settings = request.app.state.settings
    if not _is_trusted_origin(request.headers.get("origin"), settings.extension_ids):
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
    # Validated here (not just in SelectionBus) so a batch is rejected whole at
    # parse time, before any item is stored.
    kind: SelectionKind
    snippet: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)
    widget: str | None = Field(default=None, max_length=LABEL_CAP)
    project: str | None = Field(default=None, max_length=LABEL_CAP)

    @field_validator("meta")
    @classmethod
    def _cap_meta(cls, value: dict[str, Any]) -> dict[str, Any]:
        encoded = json.dumps(value, separators=(",", ":"))
        if len(encoded) > META_CAP:
            raise ValueError(f"meta too large: {len(encoded)} bytes (cap {META_CAP})")
        return value


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
    items: list[SelectionIn] = Field(min_length=1, max_length=RING_SIZE)


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
        return bus.push_many(
            [(item.kind, item.snippet, item.meta, item.widget, item.project) for item in body.items]
        )

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
    # Added before CORS so CORS wraps it: a 413 still carries CORS headers and the
    # extension sees the real status instead of an opaque network error.
    app.add_middleware(BodyLimitMiddleware, max_bytes=MAX_BODY_BYTES)  # type: ignore[invalid-argument-type]
    app.add_middleware(
        CORSMiddleware,  # type: ignore[invalid-argument-type]  # Starlette factory typing
        allow_origin_regex=_trusted_origin_regex(settings.extension_ids),
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    # Added last so it runs first: a rebinding request is refused before CORS or
    # any route sees it.
    app.add_middleware(
        HostGuardMiddleware,  # type: ignore[invalid-argument-type]
        port=settings.port,
        allow_remote=settings.allow_remote,
    )
    app.state.settings = settings
    app.state.widget_log = WidgetLog(settings.logs_dir)
    app.state.selection_bus = SelectionBus(settings.selections_db)
    app.state.event_hub = EventHub()
    app.include_router(router)
    return app
