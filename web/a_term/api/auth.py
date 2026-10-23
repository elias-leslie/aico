"""Public auth/session endpoints for the A-Term frontend."""

from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .. import auth as public_auth
from ..caller_trust import authenticate, facts_from_scope

router = APIRouter(tags=["Auth"])


class LoginRequest(BaseModel):
    password: str


class AuthSessionResponse(BaseModel):
    enabled: bool
    mode: Literal["none", "password", "proxy"]
    authenticated: bool
    identity: str | None = None


def _settings(request: Request) -> public_auth.AuthSettings:
    return request.app.state.trust.auth


def _session_response(
    settings_mode: Literal["none", "password", "proxy"],
    session: public_auth.AuthSession | None,
) -> AuthSessionResponse:
    return AuthSessionResponse(
        enabled=settings_mode != "none",
        mode=settings_mode,
        authenticated=session is not None,
        identity=session.identity if session else None,
    )


@router.get("/api/auth/session", response_model=AuthSessionResponse)
async def get_auth_session(request: Request) -> Response:
    settings = _settings(request)
    session = authenticate(facts_from_scope(request.scope), settings, int(time.time()))
    payload = _session_response(settings.mode, session).model_dump()
    response = JSONResponse(payload)

    if (
        settings.mode == "proxy"
        and session is not None
        and request.cookies.get(settings.cookie_name) is None
    ):
        public_auth.set_session_cookie(response, session, settings)

    return response


@router.post("/api/auth/login", response_model=AuthSessionResponse)
async def login(request: Request, payload: LoginRequest) -> Response:
    settings = _settings(request)
    if settings.mode != "password":
        raise HTTPException(status_code=404, detail="Password auth is not enabled")
    if not public_auth.verify_password(payload.password, settings):
        raise HTTPException(status_code=401, detail="Invalid password")

    session = public_auth.create_password_session(settings, int(time.time()))
    response = JSONResponse(_session_response(settings.mode, session).model_dump())
    public_auth.set_session_cookie(response, session, settings)
    return response


@router.post("/api/auth/logout", response_model=AuthSessionResponse)
async def logout(request: Request) -> Response:
    settings = _settings(request)
    response = JSONResponse(
        _session_response(settings.mode, None).model_dump(),
    )
    public_auth.clear_session_cookie(response, settings)
    return response
