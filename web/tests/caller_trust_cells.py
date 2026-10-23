"""Who-gets-in golden cells: every request shape the caller-trust table pins, and how to replay one.

The expected answers live in ``fixtures/caller_trust_golden.json``. They were recorded once from the app as it was
before the trust checks moved into one module, then hand-checked. Never regenerate them from the new rules: a changed
cell is a changed refusal, and every refusal must stay as it was.

Two kinds of cell changed on purpose when the one gate took over HTTP, both narrowing (74 cells):
``runs?limit=<invalid>`` without a valid internal token is refused 403 before ``limit`` is checked (was 422), and
``/v1/roots*`` and internal refusals no longer carry Access-Control-Allow-Origin for an allowed Origin.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from a_term.auth import AuthSettings

GOLDEN_PATH = Path(__file__).parent / "fixtures" / "caller_trust_golden.json"

PASSWORD = "golden password"
INTERNAL_TOKEN = "golden-internal-token"
COOKIE_NAME = "a_term_session"
PROXY_HEADER = "X-Forwarded-User"

HOSTS = {"ok": "localhost:8002", "bad": "evil.example:8002"}
ORIGINS: dict[str, str | None] = {
    "none": None,
    "same": "http://localhost:3002",
    "foreign": "https://evil.example",
    "null": "null",
}
PEERS = {"lo": ("127.0.0.1", 50000), "far": ("203.0.113.9", 5000)}
AUTHS = {
    "none": ["none"],
    "password": ["none", "valid", "invalid"],
    "proxy": ["none", "valid", "invalid", "fwd", "fwd_blank"],
}
MODES = ("none", "password", "proxy")
TEXT_BODY = "not json"


@dataclass(frozen=True)
class Cell:
    mode: str
    kind: str  # "http" or "ws"
    method: str
    path: str
    host: str = "ok"
    origin: str = "none"
    auth: str = "none"
    peer: str = "lo"
    token: str = "none"
    body: str = "none"  # "none", "json" ({} or the wrong password) or "text"
    preflight: bool = False

    @property
    def id(self) -> str:
        parts = [self.mode, self.kind, f"{self.method} {self.path}", f"host={self.host}", f"origin={self.origin}",
                 f"auth={self.auth}", f"peer={self.peer}", f"token={self.token}", f"body={self.body}"]
        if self.preflight:
            parts.append("preflight")
        return "|".join(parts)


# (method, path, body) per surface. Paths stay valid after the internal routes move module.
BROWSER = [
    ("GET", "/api/a-term/panes", "none"),
    ("POST", "/api/a-term/panes", "json"),  # {} is refused by validation (422) once let in: no side effects
    ("PUT", "/api/a-term/layout", "json"),
    ("GET", "/api/diagnostics/sessions", "none"),
    ("GET", "/metrics", "none"),
    ("GET", "/docs", "none"),
    ("GET", "/openapi.json", "none"),
    ("GET", "/redoc", "none"),
]
PUBLIC = [
    ("GET", "/health", "none"),
    ("GET", "/api/auth/session", "none"),
    ("POST", "/api/auth/logout", "none"),
    ("POST", "/api/auth/login", "json"),  # the wrong password
]
CLI_LOCAL = [
    ("GET", "/v1/roots", "none"),
    ("POST", "/v1/roots", "text"),  # not JSON: invalid_body once let in, nothing reaches Tether
    ("GET", "/v1/roots/root-x", "none"),
    ("GET", "/v1/roots/root-x/admin", "none"),
    ("POST", "/v1/roots/root-x/explode", "json"),
]
INTERNAL = [
    ("GET", "/api/internal/maintenance", "none"),
    ("POST", "/api/internal/maintenance/run", "none"),
    ("GET", "/api/internal/maintenance/runs", "none"),
    ("GET", "/api/internal/maintenance/runs?limit=0", "none"),
]
# No route fully matches these (404, 405, 307, plain OPTIONS): today's path-prefix rule decides.
FALLBACK = [
    ("GET", "/nope", "none"),
    ("POST", "/nope", "none"),
    ("GET", "/health/", "none"),
    ("GET", "/api/a-term/reset-all", "none"),
    ("PUT", "/v1/roots", "none"),
    ("GET", "/api/internal/nope", "none"),
    ("POST", "/api/internal/nope", "none"),
    ("GET", "/api/auth/nope", "none"),
    ("HEAD", "/health", "none"),
    ("OPTIONS", "/api/a-term/panes", "none"),
]
# Encoded ? and # in a path that matches no route (Starlette's request.url.path cuts these at the decoded character).
ENCODED_FALLBACK = ["/health%23x", "/health%3Fx"]
PREFLIGHT = ["/api/a-term/panes", "/v1/roots", "/api/internal/maintenance/run", "/api/auth/login"]
WS_PATH = "/ws/a-term/s1"
WS_UNMATCHED = "/ws/nope"
FAR_PEER_PATHS = {"/api/a-term/panes", "/v1/roots", "/v1/roots/root-x", "/v1/roots/root-x/admin",
                  "/v1/roots/root-x/explode", "/api/auth/session", "/metrics"}
TOKENS = ["none", "bearer", "query", "wrong", "lower_bearer", "wrong_bearer_good_query", "empty_expected"]


def _peers(path: str) -> list[str]:
    return ["lo", "far"] if path.split("?")[0] in FAR_PEER_PATHS else ["lo"]


def cells() -> list[Cell]:
    out: list[Cell] = []
    for mode in MODES:
        auths = AUTHS[mode]
        for method, path, body in BROWSER + PUBLIC + CLI_LOCAL + FALLBACK:
            for origin in ORIGINS:
                for auth in auths:
                    for peer in _peers(path):
                        out.append(Cell(mode, "http", method, path, origin=origin, auth=auth, peer=peer, body=body))
        for path in PREFLIGHT:
            for origin in ("same", "foreign", "null"):
                for auth in auths[:1] + (["valid"] if mode != "none" else []):
                    out.append(Cell(mode, "http", "OPTIONS", path, origin=origin, auth=auth, preflight=True))
        for method, path, body in INTERNAL:
            for token in ("none", "bearer"):
                for origin in ORIGINS:
                    for peer in ("lo", "far") if mode == "none" else ("lo",):
                        out.append(Cell(mode, "http", method, path, origin=origin, peer=peer, token=token, body=body))
            if mode == "none":
                for token in TOKENS[2:]:
                    out.append(Cell(mode, "http", method, path, token=token, body=body))
            else:
                out.append(Cell(mode, "http", method, path, auth="valid", body=body))
        for origin in ORIGINS:
            for auth in auths:
                out.append(Cell(mode, "ws", "GET", WS_PATH, origin=origin, auth=auth))
            out.append(Cell(mode, "ws", "GET", WS_UNMATCHED, origin=origin))
        out.append(Cell(mode, "ws", "GET", WS_PATH, auth="none", peer="far"))
        # A refused Host wins over everything, whatever else the caller brings.
        for method, path, body in BROWSER + PUBLIC + CLI_LOCAL + INTERNAL + FALLBACK:
            for auth, token in [("none", "none")] + ([("valid", "bearer")] if mode != "none" else [("none", "bearer")]):
                out.append(Cell(mode, "http", method, path, host="bad", auth=auth, token=token, body=body))
        for auth in auths[:2]:
            out.append(Cell(mode, "ws", "GET", WS_PATH, host="bad", auth=auth))
            out.append(Cell(mode, "ws", "GET", WS_PATH, host="bad", origin="foreign", auth=auth))
        # Added after the first recording, also recorded from the old code (b4f16d2):
        # the internal token never unlocks a browser route or the terminal WebSocket...
        if mode != "none":
            for token in ("bearer", "query"):
                out.append(Cell(mode, "http", "GET", "/api/a-term/panes", token=token))
                out.append(Cell(mode, "ws", "GET", WS_PATH, token=token))
        # ...and an encoded ? or # in an unmatched path is decided on the path as sent.
        for path in ENCODED_FALLBACK:
            for auth in auths:
                out.append(Cell(mode, "http", "GET", path, auth=auth))
    return out


def load_golden() -> dict[str, dict[str, Any]]:
    return json.loads(GOLDEN_PATH.read_text())


def settings_for(mode: str) -> AuthSettings:
    return AuthSettings(
        mode=mode,
        password=PASSWORD if mode == "password" else "",
        secret="golden-secret" if mode != "none" else "",
        proxy_header=PROXY_HEADER,
        cookie_name=COOKIE_NAME,
        cookie_secure=False,
        session_ttl_seconds=3600,
    )


@contextmanager
def use_auth(app: FastAPI, mode: str) -> Iterator[None]:
    """Run with auth mode ``mode`` (the one place the golden table switches auth)."""
    original = app.state.trust
    app.state.trust = replace(original, auth=settings_for(mode))
    try:
        yield
    finally:
        app.state.trust = original


def _client(app: FastAPI, cell: Cell) -> TestClient:
    return TestClient(
        app,
        base_url=f"http://{HOSTS[cell.host]}",
        client=PEERS[cell.peer],
        raise_server_exceptions=False,
        follow_redirects=False,
    )


def mint_cookie(app: FastAPI, mode: str) -> str:
    """A valid session cookie for ``mode``, made the way the browser gets one (call inside ``use_auth``)."""
    client = TestClient(app, base_url=f"http://{HOSTS['ok']}", client=PEERS["lo"])
    if mode == "password":
        response = client.post("/api/auth/login", json={"password": PASSWORD})
    else:
        response = client.get("/api/auth/session", headers={PROXY_HEADER: "owner@example.com"})
    assert response.status_code == 200, response.text
    return response.cookies[COOKIE_NAME]


def headers_for(cell: Cell, valid_cookie: str | None) -> dict[str, str]:
    headers = {"host": HOSTS[cell.host]}
    origin = ORIGINS[cell.origin]
    if origin is not None:
        headers["origin"] = origin
    if cell.auth == "valid":
        assert valid_cookie is not None
        headers["cookie"] = f"{COOKIE_NAME}={valid_cookie}"
    elif cell.auth == "invalid":
        headers["cookie"] = f"{COOKIE_NAME}=bm90LWEtc2Vzc2lvbg.not-a-signature"
    elif cell.auth == "fwd":
        headers[PROXY_HEADER] = "owner@example.com"
    elif cell.auth == "fwd_blank":
        headers[PROXY_HEADER] = "   "
    if cell.token in ("bearer", "wrong_bearer_good_query"):
        headers["authorization"] = f"Bearer {INTERNAL_TOKEN if cell.token == 'bearer' else 'wrong'}"
    elif cell.token == "wrong":
        headers["authorization"] = "Bearer wrong"
    elif cell.token == "lower_bearer":
        headers["authorization"] = f"bearer {INTERNAL_TOKEN}"
    if cell.preflight:
        headers["access-control-request-method"] = "POST"
    if cell.body == "text":
        headers["content-type"] = "text/plain"
    return headers


def url_for(cell: Cell) -> str:
    path = cell.path
    if cell.token in ("query", "wrong_bearer_good_query"):
        path += ("&" if "?" in path else "?") + f"token={INTERNAL_TOKEN}"
    elif cell.token == "empty_expected":
        path += ("&" if "?" in path else "?") + "token="
    return path


def run_cell(app: FastAPI, cell: Cell, valid_cookie: str | None) -> dict[str, Any]:
    """Send one cell's request to ``app`` (already inside ``use_auth``) and describe what came back."""
    from a_term.rate_limit import limiter

    limiter.reset()
    app.state.internal_token = "" if cell.token == "empty_expected" else INTERNAL_TOKEN
    client = _client(app, cell)
    headers = headers_for(cell, valid_cookie)
    if cell.kind == "ws":
        async def accept_then_close(websocket: WebSocket, *_args: object) -> None:
            await websocket.accept()
            await websocket.close()

        handler = AsyncMock(side_effect=accept_then_close)
        try:
            with (
                patch("a_term.api.a_term.handle_a_term_connection", handler),
                client.websocket_connect(f"ws://{HOSTS[cell.host]}{url_for(cell)}", headers=headers),
            ):
                pass
        except WebSocketDisconnect as closed:
            return {"ws_close": closed.code, "reason": closed.reason}
        return {"ws": "accepted"}

    kwargs: dict[str, Any] = {"headers": headers}
    # A let-in maintenance run answers 200 with no body recorded; never run the real cycle (it prunes uploads).
    ran = AsyncMock(return_value={})
    if cell.body == "json":
        kwargs["json"] = {"password": "wrong"} if cell.path == "/api/auth/login" else {}
    elif cell.body == "text":
        kwargs["content"] = TEXT_BODY
    with patch("a_term.api.internal.run_maintenance_cycle", ran):
        response = client.request(cell.method, url_for(cell), **kwargs)
    result: dict[str, Any] = {"status": response.status_code}
    if response.status_code >= 300 and response.status_code != 422:
        try:
            result["body"] = response.json()
        except ValueError:
            result["body"] = response.text
    result["acao"] = response.headers.get("access-control-allow-origin")
    result["sec"] = "x-content-type-options" in response.headers
    return result


def run_all(app: FastAPI, mode: str) -> dict[str, dict[str, Any]]:
    """Every cell of ``mode`` against ``app``, keyed by cell id."""
    results: dict[str, dict[str, Any]] = {}
    with use_auth(app, mode):
        cookie = mint_cookie(app, mode) if mode != "none" else None
        for cell in cells():
            if cell.mode == mode:
                results[cell.id] = run_cell(app, cell, cookie)
    return results
