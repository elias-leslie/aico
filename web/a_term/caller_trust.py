"""Who gets in: one module decides, for HTTP and the WebSocket alike, whether a caller may reach a route.

Every route declares a **surface** when it is mounted (``mount`` for a router, ``declare`` for the app's own
routes). A surface names one ordered list of checks:

- ``browser``: the UI's API and the terminal WebSocket. HTTP: auth (never for OPTIONS), then a write from another
  site's page is refused. WebSocket: another site's page is refused first, then auth.
- ``public``: health and the login routes. Only a write from another site's page is refused.
- ``cli-local``: ``/v1/roots`` for local CLI callers. Auth, a write from another site's page, a caller that is not
  on loopback (``local_only``), then any ``Origin`` at all (a browser page has no business here).
- ``internal``: maintenance routes. A write from another site's page, then the internal token.

``verdict`` is the pure decision over ``CallerFacts`` (built the same way from an HTTP or a WebSocket scope).
A route with no declared surface is always refused. A path no route fully matches (404, 405, a trailing-slash
redirect, a plain OPTIONS) keeps the old path-prefix rule: ``public`` under ``/health``, ``/api/auth/`` and
``/api/internal/``, ``browser`` everywhere else; an unmatched WebSocket path goes on to the router untouched.

The loopback ``Host`` check is separate and runs before all of this: ``Host`` is never part of ``verdict``.

Proxy-mode forwarded identity (rule kept, decision open): in proxy mode ``authenticate`` accepts the configured
forwarded-user header from any caller that passed the Host check. Every browser request now arrives from Next on
127.0.0.1, so the caller's address cannot tell a trusted front proxy's header from one a browser set. Whether Next
strips or verifies the header, a Next-to-backend secret proves the hop, or proxy mode is never enabled is still to
be decided; ``authenticate`` is the one place that decision lands. Mode ``none`` is what is deployed.
"""

from __future__ import annotations

import hmac
import re
import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Literal

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.routing import APIRouter
from starlette.datastructures import URL, Headers, QueryParams, State
from starlette.requests import cookie_parser
from starlette.routing import BaseRoute, Match
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from . import auth as public_auth
from .auth import AuthSession, AuthSettings


class Surface(StrEnum):
    BROWSER = "browser"
    CLI_LOCAL = "cli-local"
    INTERNAL = "internal"
    PUBLIC = "public"


class DenyReason(StrEnum):
    HOST_NOT_ALLOWED = "host_not_allowed"
    AUTH_REQUIRED = "auth_required"
    ORIGIN_NOT_ALLOWED = "origin_not_allowed"
    LOCAL_ONLY = "local_only"
    INTERNAL_TOKEN_REQUIRED = "internal_token_required"
    SURFACE_UNDECLARED = "surface_undeclared"


@dataclass(frozen=True)
class CallerFacts:
    """What a caller brought, read the same way from an HTTP or a WebSocket scope."""

    transport: Literal["http", "websocket"]
    method: str
    path: str
    origin: str | None
    peer: str | None
    cookies: Mapping[str, str]
    headers: Mapping[str, str]  # case-insensitive
    query_token: str


@dataclass(frozen=True)
class TrustConfig:
    """Everything ``verdict`` reads besides the caller.

    The app keeps one on ``app.state.trust`` (``trust_config``). ``allowed_origins`` is the one origin list CORS also
    gets (the same object). ``internal_token`` and ``now`` are filled per request by ``SurfaceGate``: the token lives
    on ``app.state.internal_token`` (made at startup), ``now`` is the clock.
    """

    allowed_origins: Sequence[str]
    auth: AuthSettings
    internal_token: str = ""
    now: int = 0


@dataclass(frozen=True)
class Allow:
    session: AuthSession | None = None


@dataclass(frozen=True)
class Deny:
    reason: DenyReason


LOOPBACK_PEERS = frozenset({"127.0.0.1", "::1"})
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_SURFACE_ATTR = "a_term_surface"


def trust_config(allowed_origins: Sequence[str]) -> TrustConfig:
    """The app's trust configuration: ``allowed_origins`` (pass the list CORS gets) and the configured auth."""
    return TrustConfig(allowed_origins=allowed_origins, auth=public_auth.get_auth_settings())


def request_config(state: State) -> TrustConfig:
    """``state.trust`` with this request's internal token and clock filled in."""
    return replace(state.trust, internal_token=getattr(state, "internal_token", ""), now=int(time.time()))


def facts_from_scope(scope: Scope) -> CallerFacts:
    """Read the caller's facts from an ASGI ``http`` or ``websocket`` scope."""
    headers = Headers(scope=scope)
    cookie_header = headers.get("cookie")
    client = scope.get("client")
    transport: Literal["http", "websocket"] = "websocket" if scope["type"] == "websocket" else "http"
    return CallerFacts(
        transport=transport,
        method=scope["method"] if transport == "http" else "GET",
        path=scope["path"],
        origin=headers.get("origin"),
        peer=client[0] if client else None,
        cookies=cookie_parser(cookie_header) if cookie_header else {},
        headers=headers,
        query_token=QueryParams(scope.get("query_string", b"")).get("token", ""),
    )


def authenticate(facts: CallerFacts, auth: AuthSettings, now: int) -> AuthSession | None:
    """The caller's session under ``auth``: mode none lets everyone in, else a signed cookie or a forwarded identity."""
    if auth.mode == "none":
        return AuthSession(identity="local", mode="none", expires_at=2**31)
    session = public_auth.decode_session(facts.cookies.get(auth.cookie_name), auth, now)
    if session is not None:
        return session
    identity = public_auth.get_proxy_identity(facts.headers, auth)
    if identity is not None:
        return public_auth.create_proxy_session(identity, auth, now)
    return None


def _foreign(facts: CallerFacts, config: TrustConfig) -> bool:
    return facts.origin is not None and facts.origin not in config.allowed_origins


def _foreign_write(facts: CallerFacts, config: TrustConfig) -> bool:
    """A state change (or a WebSocket) from a page whose Origin is not in the one list (``null`` included)."""
    changes_state = facts.method in UNSAFE_METHODS or facts.transport == "websocket"
    return changes_state and _foreign(facts, config)


def _internal_token_ok(facts: CallerFacts, expected: str) -> bool:
    """``Bearer <token>`` if that header is sent, else ``?token=``; an empty expected token lets nobody in."""
    header = facts.headers.get("authorization", "")
    token = header[7:] if header.startswith("Bearer ") else facts.query_token
    return bool(expected) and hmac.compare_digest(token.encode(), expected.encode())


def verdict(facts: CallerFacts, surface: Surface | None, config: TrustConfig) -> Allow | Deny:
    """Whether the caller may reach a route on ``surface``; the first failing check names the refusal."""
    if surface is None:
        return Deny(DenyReason.SURFACE_UNDECLARED)

    if surface is Surface.BROWSER and facts.transport == "websocket":
        if _foreign(facts, config):
            return Deny(DenyReason.ORIGIN_NOT_ALLOWED)
        session = authenticate(facts, config.auth, config.now)
        return Deny(DenyReason.AUTH_REQUIRED) if session is None else Allow(session)

    session: AuthSession | None = None
    if surface in (Surface.BROWSER, Surface.CLI_LOCAL) and facts.method != "OPTIONS":
        session = authenticate(facts, config.auth, config.now)
        if session is None:
            return Deny(DenyReason.AUTH_REQUIRED)
    if _foreign_write(facts, config):
        return Deny(DenyReason.ORIGIN_NOT_ALLOWED)
    if surface is Surface.CLI_LOCAL:
        if facts.peer not in LOOPBACK_PEERS:
            return Deny(DenyReason.LOCAL_ONLY)
        if facts.origin is not None:
            return Deny(DenyReason.ORIGIN_NOT_ALLOWED)
    if surface is Surface.INTERNAL and not _internal_token_ok(facts, config.internal_token):
        return Deny(DenyReason.INTERNAL_TOKEN_REQUIRED)
    return Allow(session)


# ---------------------------------------------------------------------------
# Declaring surfaces
# ---------------------------------------------------------------------------
def _mark(route: BaseRoute, surface: Surface) -> None:
    setattr(route, _SURFACE_ATTR, surface)


def declared_surface(route: BaseRoute) -> Surface | None:
    """The surface ``route`` was mounted or declared with, or None."""
    surface = getattr(route, _SURFACE_ATTR, None)
    return surface if isinstance(surface, Surface) else None


def mount(app: FastAPI, router: APIRouter, surface: Surface) -> None:
    """Include ``router`` in ``app`` with every one of its routes on ``surface``."""
    before = len(app.router.routes)
    app.include_router(router)
    for route in app.router.routes[before:]:
        _mark(route, surface)


def declare(app: FastAPI, surfaces: Mapping[str, Surface]) -> None:
    """Put the app's own routes (by path) on a surface; a path with no route is a mistake."""
    seen: set[str] = set()
    for route in app.router.routes:
        path = getattr(route, "path", None)
        if isinstance(path, str) and path in surfaces:
            _mark(route, surfaces[path])
            seen.add(path)
    missing = set(surfaces) - seen
    if missing:
        raise ValueError(f"no route to declare: {sorted(missing)}")


# ---------------------------------------------------------------------------
# Deciding for one request
# ---------------------------------------------------------------------------
def _full_match(routes: Iterable[BaseRoute], scope: Scope) -> BaseRoute | None:
    for route in routes:
        match, _ = route.matches(scope)
        if match is Match.FULL:
            return route
    return None


def _prefix_surface(path: str) -> Surface:
    """The old rule for a path no route fully matches."""
    if path == "/health" or path.startswith(("/api/auth/", "/api/internal/")):
        return Surface.PUBLIC
    return Surface.BROWSER


def check(scope: Scope, routes: Iterable[BaseRoute], config: TrustConfig) -> Allow | Deny:
    """Decide one HTTP or WebSocket scope against the app's routes (Host already checked)."""
    route = _full_match(routes, scope)
    if route is not None:
        surface = declared_surface(route)
    elif scope["type"] == "websocket":
        return Allow()  # no WebSocket route here: the router closes it
    else:
        # Read the path as the old auth check did (request.url.path): it ends at a decoded ? or #, so
        # /health%23x counts as /health. It only decides which refusal an unmatched path gets, never a handler.
        surface = _prefix_surface(URL(scope=scope).path)
    return verdict(facts_from_scope(scope), surface, config)


# ---------------------------------------------------------------------------
# Gates (ASGI middleware)
# ---------------------------------------------------------------------------
# Host header values the backend answers: loopback names, any port. Next's rewrite (changeOrigin) and local
# clients (CLI, Aico) send these. X-Forwarded-Host is never consulted.
_LOOPBACK_HOST = re.compile(r"(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?")

# Each refusal's HTTP answer and WebSocket close (code, reason), exactly as the old per-route checks gave them.
_HTTP_REFUSALS: dict[DenyReason, tuple[int, dict[str, str]]] = {
    DenyReason.HOST_NOT_ALLOWED: (403, {"error": "host_not_allowed"}),
    DenyReason.AUTH_REQUIRED: (401, {"detail": public_auth.UNAUTHORIZED_DETAIL}),
    DenyReason.ORIGIN_NOT_ALLOWED: (403, {"error": "origin_not_allowed"}),
    DenyReason.LOCAL_ONLY: (403, {"error": "local_only"}),
    DenyReason.INTERNAL_TOKEN_REQUIRED: (403, {"detail": "Unauthorized"}),
    DenyReason.SURFACE_UNDECLARED: (403, {"error": "surface_undeclared"}),
}
_WS_REFUSALS: dict[DenyReason, tuple[int, str]] = {
    DenyReason.HOST_NOT_ALLOWED: (1008, "Host not allowed"),
    DenyReason.AUTH_REQUIRED: (public_auth.UNAUTHORIZED_WS_CODE, public_auth.UNAUTHORIZED_DETAIL),
    DenyReason.ORIGIN_NOT_ALLOWED: (1008, "Origin not allowed"),
    DenyReason.LOCAL_ONLY: (1008, "Local clients only"),  # no WebSocket route is on this surface
    DenyReason.INTERNAL_TOKEN_REQUIRED: (1008, "Unauthorized"),  # nor on this one
    DenyReason.SURFACE_UNDECLARED: (1008, "Surface not declared"),
}


def host_allowed(host: str) -> bool:
    """Whether a ``Host`` header value names loopback (lower-cased by the caller)."""
    return _LOOPBACK_HOST.fullmatch(host) is not None


def http_refusal(reason: DenyReason) -> JSONResponse:
    status, body = _HTTP_REFUSALS[reason]
    return JSONResponse(status_code=status, content=body)


def ws_refusal(reason: DenyReason) -> WebSocketClose:
    """Close before accept: the same ASGI message the endpoint used to send (uvicorn answers the handshake 403)."""
    code, text = _WS_REFUSALS[reason]
    return WebSocketClose(code=code, reason=text)


class HostGate:
    """Refuse every HTTP request (403) and WebSocket (close 1008) whose Host is not loopback.

    Auth mode none leaves the API open to anything that reaches the socket. A reverse proxy that forwards the original
    Host (Caddy on :443 for the public host) or a DNS-rebinding page would otherwise reach it from off the box.
    Outermost: nothing else runs for a refused Host.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            host = next((v for k, v in scope["headers"] if k == b"host"), b"").decode("latin-1").lower()
            if not host_allowed(host):
                refusal = ws_refusal if scope["type"] == "websocket" else http_refusal
                await refusal(DenyReason.HOST_NOT_ALLOWED)(scope, receive, send)
                return
        await self.app(scope, receive, send)


class SurfaceGate:
    """Apply each route's surface to every HTTP request and WebSocket before CORS and the router see it.

    Sits inside the security headers (so refusals carry them) and outside CORS (so a refusal never gets an
    Access-Control-Allow-Origin header). Reads ``app.state.trust``.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            application = scope["app"]
            decided = check(scope, application.router.routes, request_config(application.state))
            if isinstance(decided, Deny):
                refusal = ws_refusal if scope["type"] == "websocket" else http_refusal
                await refusal(decided.reason)(scope, receive, send)
                return
        await self.app(scope, receive, send)
