"""Every route declares who may reach it, and the one trust decision agrees with the recorded golden answers."""

from __future__ import annotations

import time
from typing import Any

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from a_term.caller_trust import (
    Allow,
    CallerFacts,
    Deny,
    DenyReason,
    Surface,
    TrustConfig,
    check,
    declare,
    declared_surface,
    facts_from_scope,
    mount,
    verdict,
)
from a_term.config import settings

from .caller_trust_cells import (
    INTERNAL_TOKEN,
    MODES,
    PEERS,
    Cell,
    auth_settings,
    cells,
    headers_for,
    load_golden,
    mint_cookie,
    url_for,
    use_auth,
)

# Every (method, path) the app serves and the surface it declares. Adding a route means adding it here.
SURFACES: dict[Surface, list[tuple[str, str]]] = {
    Surface.BROWSER: [
        ("GET", "/openapi.json"),
        ("GET", "/docs"),
        ("GET", "/docs/oauth2-redirect"),
        ("GET", "/redoc"),
        ("WS", "/ws/a-term/{session_id}"),
        ("GET", "/api/a-term/sessions"),
        ("GET", "/api/a-term/sessions/{session_id}"),
        ("PATCH", "/api/a-term/sessions/{session_id}"),
        ("DELETE", "/api/a-term/sessions/{session_id}"),
        ("POST", "/api/a-term/sessions/{session_id}/reset"),
        ("POST", "/api/a-term/reset-all"),
        ("GET", "/api/a-term/panes"),
        ("GET", "/api/a-term/panes/detached"),
        ("GET", "/api/a-term/panes/count"),
        ("POST", "/api/a-term/panes"),
        ("GET", "/api/a-term/panes/{pane_id}"),
        ("PATCH", "/api/a-term/panes/{pane_id}"),
        ("DELETE", "/api/a-term/panes/{pane_id}"),
        ("POST", "/api/a-term/panes/{pane_id}/detach"),
        ("POST", "/api/a-term/panes/{pane_id}/attach"),
        ("POST", "/api/a-term/panes/swap"),
        ("PUT", "/api/a-term/panes/order"),
        ("PATCH", "/api/a-term/panes/{pane_id}/layout"),
        ("PUT", "/api/a-term/layout"),
        ("PUT", "/api/a-term/panes/{pane_id}/agent-tool"),
        ("GET", "/api/a-term/projects"),
        ("GET", "/api/a-term/projects/context"),
        ("POST", "/api/a-term/projects"),
        ("PUT", "/api/a-term/project-settings/{project_id}"),
        ("POST", "/api/a-term/project-settings/bulk-order"),
        ("POST", "/api/a-term/projects/{project_id}/reset"),
        ("POST", "/api/a-term/projects/{project_id}/disable"),
        ("PUT", "/api/a-term/projects/{project_id}/mode"),
        ("GET", "/api/a-term/sessions/{session_id}/agent-state"),
        ("GET", "/api/a-term/sessions/{session_id}/claude-state"),
        ("POST", "/api/a-term/sessions/{session_id}/start-agent"),
        ("POST", "/api/a-term/sessions/{session_id}/start-claude"),
        ("GET", "/api/a-term/agent-tools"),
        ("GET", "/api/a-term/agent-tools/{tool_ref}"),
        ("POST", "/api/a-term/agent-tools"),
        ("PATCH", "/api/a-term/agent-tools/{tool_ref}"),
        ("DELETE", "/api/a-term/agent-tools/{tool_ref}"),
        ("GET", "/api/a-term/files/limits"),
        ("POST", "/api/a-term/files"),
        ("GET", "/api/a-term/panes/{pane_id}/files/tree"),
        ("GET", "/api/a-term/panes/{pane_id}/files/content"),
        ("GET", "/api/diagnostics/sessions"),
        ("GET", "/api/diagnostics/sessions/{session_id}/events"),
        ("GET", "/api/diagnostics/sessions/{session_id}/summary"),
        ("GET", "/metrics"),
    ],
    Surface.PUBLIC: [
        ("GET", "/api/auth/session"),
        ("POST", "/api/auth/login"),
        ("POST", "/api/auth/logout"),
        ("GET", "/health"),
    ],
    Surface.CLI_LOCAL: [
        ("GET", "/v1/roots"),
        ("POST", "/v1/roots"),
        ("GET", "/v1/roots/{request_id}"),
        ("GET", "/v1/roots/{request_id}/admin"),
        ("POST", "/v1/roots/{request_id}/{action}"),
    ],
    Surface.INTERNAL: [
        ("GET", "/api/internal/maintenance"),
        ("POST", "/api/internal/maintenance/run"),
        ("GET", "/api/internal/maintenance/runs"),
    ],
}


def _app() -> FastAPI:
    from a_term.main import app

    return app


def _served(app: FastAPI) -> dict[tuple[str, str], Surface | None]:
    served: dict[tuple[str, str], Surface | None] = {}
    for route in app.routes:
        methods = getattr(route, "methods", None) or {"WS"}
        for method in sorted(methods - {"HEAD"}):
            served[(method, getattr(route, "path", ""))] = declared_surface(route)
    return served


def test_every_route_declares_a_surface() -> None:
    undeclared = [key for key, surface in _served(_app()).items() if surface is None]
    assert undeclared == []


def test_route_surfaces_match_the_snapshot() -> None:
    expected = {key: surface for surface, keys in SURFACES.items() for key in keys}
    assert len(expected) == 62
    assert _served(_app()) == expected


def test_one_origin_list_feeds_cors_and_the_trust_checks() -> None:
    # The #20 merge: CORS, the write guard and the WebSocket all read this one list object.
    cors = [entry for entry in _app().user_middleware if entry.cls is CORSMiddleware]
    assert len(cors) == 1
    assert cors[0].kwargs["allow_origins"] is settings.a_term_allowed_origins


def test_middleware_order_is_pinned() -> None:
    names = [getattr(entry.cls, "__name__", "") for entry in _app().user_middleware]
    dispatches = [
        getattr(entry.kwargs.get("dispatch"), "__name__", None) for entry in _app().user_middleware
    ]
    # Outermost first: the Host check, security headers, auth, the foreign-Origin write guard, CORS.
    assert names == ["LoopbackHostGuard", "BaseHTTPMiddleware", "BaseHTTPMiddleware", "BaseHTTPMiddleware",
                     "CORSMiddleware"]
    assert dispatches == [None, "security_headers", "auth_guard", "foreign_origin_guard", None]


def _config(mode: str = "none", token: str = INTERNAL_TOKEN) -> TrustConfig:
    return TrustConfig(
        allowed_origins=settings.a_term_allowed_origins,
        auth=auth_settings(mode),
        internal_token=token,
        now=int(time.time()),
    )


def test_a_router_included_without_mount_is_refused() -> None:
    throwaway = FastAPI()
    router = APIRouter()

    @router.get("/sneaky")
    async def sneaky() -> dict[str, str]:
        return {}

    throwaway.include_router(router)
    scope = {"type": "http", "method": "GET", "path": "/sneaky", "root_path": "", "query_string": b"",
             "headers": [], "client": PEERS["lo"]}
    assert check(scope, throwaway.router.routes, _config()) == Deny(DenyReason.SURFACE_UNDECLARED)

    mounted = FastAPI()
    mount(mounted, router, Surface.PUBLIC)
    assert check(scope, mounted.router.routes, _config()) == Allow()


def test_declare_refuses_a_path_with_no_route() -> None:
    with pytest.raises(ValueError, match="/nowhere"):
        declare(FastAPI(), {"/nowhere": Surface.PUBLIC})


def _facts(**overrides: Any) -> CallerFacts:
    values: dict[str, Any] = {"transport": "http", "method": "GET", "path": "/x", "origin": None,
                              "peer": "127.0.0.1", "cookies": {}, "headers": {}, "query_token": ""}
    values.update(overrides)
    return CallerFacts(**values)


def test_an_undeclared_surface_always_denies() -> None:
    assert verdict(_facts(), None, _config()) == Deny(DenyReason.SURFACE_UNDECLARED)
    assert verdict(_facts(transport="websocket"), None, _config()) == Deny(DenyReason.SURFACE_UNDECLARED)


def test_options_is_never_refused_by_auth() -> None:
    for surface in Surface:
        result = verdict(_facts(method="OPTIONS"), surface, _config("password"))
        assert result != Deny(DenyReason.AUTH_REQUIRED)


def test_a_websocket_on_any_surface_refuses_a_foreign_origin() -> None:
    for surface in Surface:
        result = verdict(_facts(transport="websocket", origin="https://evil.example"), surface, _config())
        assert result == Deny(DenyReason.ORIGIN_NOT_ALLOWED)


def test_facts_read_the_same_from_http_and_websocket_scopes() -> None:
    headers = [(b"origin", b"http://localhost:3002"), (b"cookie", b"a=1; b=2"), (b"x-forwarded-user", b"me"),
               (b"authorization", b"Bearer t")]
    http = facts_from_scope({"type": "http", "method": "POST", "path": "/p", "query_string": b"token=q&token=r",
                             "headers": headers, "client": ("::1", 1)})
    ws = facts_from_scope({"type": "websocket", "path": "/p", "query_string": b"token=q&token=r",
                           "headers": headers, "client": ("::1", 1)})
    for facts in (http, ws):
        assert (facts.origin, facts.peer, dict(facts.cookies), facts.query_token) == (
            "http://localhost:3002", "::1", {"a": "1", "b": "2"}, "r"  # the last token, as FastAPI reads it
        )
        assert facts.headers.get("X-Forwarded-User") == "me"
    assert (http.transport, http.method, ws.transport, ws.method) == ("http", "POST", "websocket", "GET")


# ---------------------------------------------------------------------------
# Shadow parity: the pure decision agrees with every recorded live answer
# ---------------------------------------------------------------------------
def _recorded_decision(result: dict[str, Any]) -> Allow | Deny | str:
    """What the old checks decided, read off a recorded answer (``"host"`` for a refused Host)."""
    if result.get("ws_close") == 1008 and result.get("reason") == "Host not allowed":
        return "host"
    if result.get("ws_close") == 1008:
        return Deny(DenyReason.ORIGIN_NOT_ALLOWED)
    if result.get("ws_close") == 4401:
        return Deny(DenyReason.AUTH_REQUIRED)
    body = result.get("body")
    if result.get("status") == 403 and result.get("sec") is False:  # HEAD gets the same refusal without a body
        return "host"
    if result.get("status") == 401 and body == {"detail": "Authentication required"}:
        return Deny(DenyReason.AUTH_REQUIRED)
    if result.get("status") == 403 and body == {"error": "origin_not_allowed"}:
        return Deny(DenyReason.ORIGIN_NOT_ALLOWED)
    if result.get("status") == 403 and body == {"error": "local_only"}:
        return Deny(DenyReason.LOCAL_ONLY)
    if result.get("status") == 403 and body == {"detail": "Unauthorized"}:
        return Deny(DenyReason.INTERNAL_TOKEN_REQUIRED)
    return Allow()


def _is_known_divergence(cell: Cell) -> bool:
    """Today FastAPI checks ``limit`` before the handler checks the token; the one module checks the token first."""
    return cell.path.endswith("runs?limit=0") and cell.token not in ("bearer", "query")


def _scope(cell: Cell, cookie: str | None) -> dict[str, Any]:
    path, _, query = url_for(cell).partition("?")
    scope: dict[str, Any] = {
        "type": "websocket" if cell.kind == "ws" else "http",
        "path": path,
        "root_path": "",
        "query_string": query.encode(),
        "headers": [(key.lower().encode("latin-1"), value.encode("latin-1"))
                    for key, value in headers_for(cell, cookie).items()],
        "client": PEERS[cell.peer],
    }
    if cell.kind == "http":
        scope["method"] = cell.method
    return scope


@pytest.mark.parametrize("mode", MODES)
def test_the_decision_agrees_with_every_recorded_answer(test_app: TestClient, mode: str) -> None:
    app = test_app.app
    assert isinstance(app, FastAPI)
    golden = load_golden()
    disagreements: list[str] = []
    with use_auth(app, mode):
        cookie = mint_cookie(app, mode) if mode != "none" else None
    for cell in cells():
        if cell.mode != mode or cell.host != "ok":
            continue
        recorded = _recorded_decision(golden[cell.id])
        assert recorded != "host", cell.id
        config = _config(mode, "" if cell.token == "empty_expected" else INTERNAL_TOKEN)
        decided = check(_scope(cell, cookie), app.router.routes, config)
        if isinstance(decided, Allow):
            decided = Allow()
        expected = Deny(DenyReason.INTERNAL_TOKEN_REQUIRED) if _is_known_divergence(cell) else recorded
        if decided != expected:
            disagreements.append(f"{cell.id}: recorded {recorded}, decided {decided}")
    assert disagreements == []
