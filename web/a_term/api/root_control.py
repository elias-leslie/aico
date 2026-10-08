"""Local-only HTTP root descriptors using the existing authenticated owner app."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from ..config import CORS_ORIGINS
from ..services import root_workloads as roots
from ..storage import root_requests

router = APIRouter(tags=["Root Workloads"])


def _local(request: Request) -> None:
    if request.client is None or request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise roots.RootError(403, "local_only")
    if request.headers.get("origin") and request.headers["origin"] not in CORS_ORIGINS:
        raise roots.RootError(403, "origin_not_allowed")


async def _body(request: Request) -> Any:
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
        raise roots.RootError(400, "invalid_body")
    parts = bytearray()
    async for part in request.stream():
        parts.extend(part)
        if len(parts) > 128 * 1024:
            raise roots.RootError(400, "invalid_body")
    try:
        return json.loads(parts)
    except (ValueError, UnicodeError):
        raise roots.RootError(400, "invalid_body") from None


def _error(error: roots.RootError) -> JSONResponse:
    value: dict[str, Any] = {"error": error.error}
    if error.error == "directed_delivery_unavailable":
        value["directedDelivery"] = roots.DIRECTED_DELIVERY
    if error.error == "position_unavailable":
        value["position"] = roots.POSITION
    return JSONResponse(value, status_code=error.status)


@router.get("/v1/roots")
def list_roots(request: Request):
    try:
        _local(request)
        return {"owner": "a-term", "available": True,
                "directedDelivery": roots.DIRECTED_DELIVERY, "position": roots.POSITION,
                "roots": [roots.describe(row) for row in root_requests.list_all()]}
    except roots.RootError as error:
        return _error(error)
    except Exception:
        return JSONResponse({"error": "owner_failure"}, status_code=503)


@router.post("/v1/roots")
async def create_root(request: Request):
    try:
        _local(request)
        value = await _body(request)
        # Keep blocking DB/owner process operations off the ASGI event loop.
        descriptor = await run_in_threadpool(roots.create, value)
        return JSONResponse(descriptor, status_code=200 if descriptor["status"] in {"running", "ended"} else 202)
    except roots.RootError as error:
        return _error(error)
    except Exception:
        return JSONResponse({"error": "owner_failure"}, status_code=503)


@router.get("/v1/roots/{request_id}")
def get_root(request: Request, request_id: str):
    try:
        _local(request)
        return roots.get(request_id)
    except roots.RootError as error:
        return _error(error)
    except Exception:
        return JSONResponse({"error": "owner_failure"}, status_code=503)


@router.post("/v1/roots/{request_id}/{action}")
async def mutate_root(request: Request, request_id: str, action: str):
    try:
        _local(request)
        if action not in {"show", "position", "send", "end", "title"}:
            raise roots.RootError(404, "not_found")
        value = None if action == "send" else await _body(request)
        return await run_in_threadpool(roots.mutate, request_id, action, value)
    except roots.RootError as error:
        return _error(error)
    except Exception:
        return JSONResponse({"error": "owner_failure"}, status_code=503)
