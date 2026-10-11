"""Local-only ``/v1/roots``: SummitFlow's A-Term root surface, served by Tether.

SummitFlow fleet calls ``http://127.0.0.1:8002/v1/roots`` with surface
``a-term``. Tether owns the roots. These routes forward to Tether with
``origin: "a-term"`` so Tether stores the requesting app, lists only A-Term's
roots (``GET /v1/roots?origin=a-term``, passing ``ended`` through) and reports ``owner: "a-term"`` on
them itself. ``title`` is Tether's (it renames without a GUI). The view-only
actions stay here because views belong to A-Term:

- ``show`` makes sure an A-Term pane shows the root's session and brings it
  into the layout.
- ``position`` has no meaning in the browser grid and answers
  ``503 position_unavailable``.

The routes keep their old guard: loopback clients only, a matching origin if
one is sent, and the app's normal auth middleware.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from ..config import CORS_ORIGINS
from ..logging_config import get_logger
from ..services import session_catalog
from ..storage import panes as pane_store
from ..tether import TetherError, TetherUnavailable, get_client

logger = get_logger(__name__)

router = APIRouter(tags=["Root Workloads"])

OWNER = "a-term"
KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
GENERATION = re.compile(r"[0-9a-f]{64}\Z")
DIRECTED_DELIVERY = {"available": False, "reason": "exact_thread_generation_receipt_unqualified"}
POSITION = {"available": False, "reason": "browser_grid_has_no_pixel_window_bounds"}
_MAX_BODY_BYTES = 128 * 1024
_LIST_QUERY = {"ended"}


class RootError(Exception):
    def __init__(self, status: int, error: str) -> None:
        self.status, self.error = status, error
        super().__init__(error)


def _local(request: Request) -> None:
    if request.client is None or request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise RootError(403, "local_only")
    if request.headers.get("origin") and request.headers["origin"] not in CORS_ORIGINS:
        raise RootError(403, "origin_not_allowed")


async def _body(request: Request) -> Any:
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
        raise RootError(400, "invalid_body")
    parts = bytearray()
    async for part in request.stream():
        parts.extend(part)
        if len(parts) > _MAX_BODY_BYTES:
            raise RootError(400, "invalid_body")
    try:
        return json.loads(parts)
    except (ValueError, UnicodeError):
        raise RootError(400, "invalid_body") from None


def _error(error: RootError) -> JSONResponse:
    value: dict[str, Any] = {"error": error.error}
    if error.error == "directed_delivery_unavailable":
        value["directedDelivery"] = DIRECTED_DELIVERY
    if error.error == "position_unavailable":
        value["position"] = POSITION
    return JSONResponse(value, status_code=error.status)


def _present(descriptor: Any) -> Any:
    """Tether's descriptor plus this surface's view capabilities (``owner`` is Tether's)."""
    if not isinstance(descriptor, dict):
        return descriptor
    presented = dict(descriptor)
    presented["position"] = POSITION
    presented.setdefault("directedDelivery", DIRECTED_DELIVERY)
    return presented


def _forward(method: str, path: str, body: Any = None) -> JSONResponse:
    try:
        response = get_client().raw(method, path, body)
    except TetherUnavailable:
        return JSONResponse({"error": "owner_failure"}, status_code=503)
    except TetherError as error:
        return JSONResponse({"error": error.code}, status_code=409 if error.status == 0 else 503)
    if isinstance(response.body, dict) and isinstance(response.body.get("roots"), list):
        content = {**response.body, "position": POSITION,
                   "roots": [_present(root) for root in response.body["roots"]]}
    elif isinstance(response.body, dict) and "error" not in response.body:
        content = _present(response.body)
    else:
        content = response.body if response.body is not None else {}
    return JSONResponse(content, status_code=response.status)


def _root_path(request_id: str, *rest: str) -> str:
    if not KEY.fullmatch(request_id):
        raise RootError(404, "not_found")
    return "/".join(["/v1/roots", request_id, *rest])


def _read_root(request_id: str) -> dict[str, Any]:
    try:
        descriptor = get_client().call("GET", _root_path(request_id))
    except TetherError as error:
        raise RootError(error.status if error.status else 409, error.code) from None
    if not isinstance(descriptor, dict):
        raise RootError(503, "owner_failure")
    return descriptor


def _checked(request_id: str, value: Any, keys: set[str]) -> dict[str, Any]:
    """Generation-fence a view action exactly as the owner does."""
    if (
        not isinstance(value, dict)
        or value.keys() != keys
        or not isinstance(value.get("generation"), str)
        or not GENERATION.fullmatch(value["generation"])
    ):
        raise RootError(400, "invalid_body")
    descriptor = _read_root(request_id)
    if descriptor.get("status") == "ended":
        raise RootError(410, "ended")
    if descriptor.get("generation") != value["generation"]:
        raise RootError(409, "stale_generation")
    if descriptor.get("status") != "running":
        raise RootError(409, "workload_unavailable")
    return descriptor


def ensure_view(session_id: str, *, show: bool) -> dict[str, Any] | None:
    """Make sure an A-Term pane shows ``session_id``; bring it into the layout if ``show``."""
    link = pane_store.get_link(session_id)
    if link is None:
        try:
            session = session_catalog.from_tether(get_client().get_session(session_id), None)
        except (TetherError, TetherUnavailable):
            return None
        project_id = session.get("project_id")
        pane = pane_store.create_pane(
            pane_type="project" if project_id else "adhoc",
            pane_name=str(session.get("name") or project_id or "Root"),
            project_id=project_id if project_id else None,
            active_mode=str(session.get("mode") or "shell"),
            is_detached=True,
        )
        pane_store.link_session(session_id, pane["id"], str(session.get("mode") or "shell"))
        link = pane_store.get_link(session_id)
    if link is None:
        return None
    pane = pane_store.get_pane(str(link["pane_id"]))
    if show and pane is not None and pane.get("is_detached"):
        try:
            pane = pane_store.attach_pane(str(link["pane_id"]))
        except ValueError:
            raise RootError(409, "view_unavailable") from None
    return pane


def _create(value: Any) -> JSONResponse:
    """Forward a root request as A-Term's: ``origin: "a-term"`` and an A-Term session id.

    Neither field is part of Tether's request digest, so a retried request
    with a fresh ``aTermSessionId`` still finds the same root.
    """
    if not isinstance(value, dict):
        raise RootError(400, "invalid_body")
    if value.get("origin", OWNER) != OWNER:
        raise RootError(400, "invalid_body")
    value = {**value, "origin": OWNER}
    value.setdefault("aTermSessionId", str(uuid.uuid4()))
    response = _forward("POST", "/v1/roots", value)
    if response.status_code in {200, 202}:
        descriptor = json.loads(bytes(response.body))
        session_id = descriptor.get("hostIdentity") if isinstance(descriptor, dict) else None
        if isinstance(session_id, str) and descriptor.get("status") in {"running", "pending"}:
            try:
                ensure_view(session_id, show=False)
            except Exception as error:  # the root exists either way; the view can follow on show
                logger.warning("root_view_link_failed", session_id=session_id, error=str(error))
    return response


def _show(request_id: str, value: Any) -> dict[str, Any]:
    descriptor = _checked(request_id, value, {"generation"})
    session_id = descriptor.get("hostIdentity")
    if not isinstance(session_id, str) or ensure_view(session_id, show=True) is None:
        raise RootError(409, "view_unavailable")
    return _present(descriptor)


def _position(request_id: str, value: Any) -> dict[str, Any]:
    _checked(request_id, value, {"generation", "bounds"})
    raise RootError(503, "position_unavailable")


def _guarded(fn: Any, *args: Any) -> Any:
    try:
        return fn(*args)
    except RootError as error:
        return _error(error)
    except TetherUnavailable:
        return JSONResponse({"error": "owner_failure"}, status_code=503)
    except Exception as error:
        logger.warning("root_control_failed", error=type(error).__name__)
        return JSONResponse({"error": "owner_failure"}, status_code=503)


@router.get("/v1/roots")
async def list_roots(request: Request):
    try:
        _local(request)
    except RootError as error:
        return _error(error)
    # Forward the filters Tether defines (``ended``); ``origin`` is always A-Term's.
    query = {key: value for key, value in request.query_params.items() if key in _LIST_QUERY}
    path = "/v1/roots?" + urlencode({**query, "origin": OWNER})
    return await run_in_threadpool(_guarded, _forward, "GET", path)


@router.post("/v1/roots")
async def create_root(request: Request):
    try:
        _local(request)
        value = await _body(request)
    except RootError as error:
        return _error(error)
    return await run_in_threadpool(_guarded, _create, value)


@router.get("/v1/roots/{request_id}")
async def get_root(request: Request, request_id: str):
    try:
        _local(request)
        path = _root_path(request_id)
    except RootError as error:
        return _error(error)
    return await run_in_threadpool(_guarded, _forward, "GET", path)


@router.get("/v1/roots/{request_id}/admin")
async def root_admin_status(request: Request, request_id: str):
    try:
        _local(request)
        path = _root_path(request_id, "admin")
    except RootError as error:
        return _error(error)
    return await run_in_threadpool(_guarded, _forward, "GET", path)


@router.post("/v1/roots/{request_id}/{action}")
async def mutate_root(request: Request, request_id: str, action: str):
    try:
        _local(request)
        if action not in {"show", "position", "send", "end", "title", "admin"}:
            raise RootError(404, "not_found")
        path = _root_path(request_id, action)
        value = None if action == "send" else await _body(request)
    except RootError as error:
        return _error(error)
    if action == "position":
        return await run_in_threadpool(_guarded, _position, request_id, value)
    if action == "show":
        return await run_in_threadpool(_guarded, _show, request_id, value)
    return await run_in_threadpool(_guarded, _forward, "POST", path, value)
