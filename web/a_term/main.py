"""A-Term Service - FastAPI Application.

The web terminal app. Tether owns the sessions; A-Term attaches views to
them, keeps its pane layout in a local SQLite file and serves the browser UI's
API on port 8002.
"""

import asyncio
import os
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from .api import (
    a_term,
    agent,
    agent_tools,
    auth,
    diagnostics,
    files,
    internal,
    memory_policy,
    pane_files,
    panes,
    projects,
    root_control,
    sessions,
    shows,
)
from .branding import DESCRIPTION, DISPLAY_NAME, get_cache_root
from .caller_trust import (
    HostGate,
    Surface,
    SurfaceGate,
    declare,
    mount,
    trust_config,
)
from .config import A_TERM_BIND_HOST, A_TERM_PORT, ALLOWED_ORIGINS
from .logging_config import SyslogPrefixFormatter, configure_logging, get_logger
from .rate_limit import limiter
from .services.maintenance import get_status as get_maintenance_status
from .services.maintenance import start_scheduler, stop_scheduler
from .services.tether_events import start_watcher, stop_watcher
from .storage import local_db
from .tether import MIN_API_VERSION, TetherError, TetherUnavailable, TetherVersionError, get_client
from .utils.tmux import run_tmux_command

# Configure structured logging (skip in test mode - tests configure their own logging)
if not os.getenv("PYTEST_CURRENT_TEST"):
    configure_logging()

    # Configure uvicorn loggers to use syslog prefixes for journald
    import logging

    uvicorn_access_logger = logging.getLogger("uvicorn.access")
    uvicorn_error_logger = logging.getLogger("uvicorn.error")
    uvicorn_logger = logging.getLogger("uvicorn")

    # Apply syslog formatter to all uvicorn handlers
    for _uvicorn_log in [uvicorn_access_logger, uvicorn_error_logger, uvicorn_logger]:
        for _handler in _uvicorn_log.handlers:
            _handler.setFormatter(
                SyslogPrefixFormatter(
                    "%(levelname)s:     %(message)s"  # Match uvicorn's format
                )
            )

logger = get_logger(__name__)


def _app_version() -> str:
    try:
        return version("a-term")
    except PackageNotFoundError:
        return "0.0.0"


def _write_internal_token(token: str) -> None:
    """Store the internal token (mode 0600) for local maintenance callers."""
    cache_root = get_cache_root()
    cache_root.mkdir(parents=True, exist_ok=True)
    token_file = cache_root / "internal-token"
    token_file.touch(mode=0o600, exist_ok=True)
    token_file.chmod(0o600)
    token_file.write_text(token)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan handler."""
    logger.info("a_term_service_starting", port=A_TERM_PORT)
    app.state.maintenance_status = {}

    local_db.initialize()
    app.state.internal_token = secrets.token_urlsafe(32)
    _write_internal_token(app.state.internal_token)
    start_watcher()
    await start_scheduler(app)

    yield

    # Shutdown
    logger.info("a_term_service_stopping")
    stop_watcher()
    await stop_scheduler(app)
    logger.info("a_term_service_shutdown_complete")


app = FastAPI(
    title=DISPLAY_NAME,
    description=DESCRIPTION,
    version=_app_version(),
    lifespan=lifespan,
)

# Who gets in reads this: the one origin list (the same object CORS gets below) and the auth settings.
app.state.trust = trust_config(ALLOWED_ORIGINS)

# Rate limiting
app.state.limiter = limiter
app.add_exception_handler(
    RateLimitExceeded,
    _rate_limit_exceeded_handler,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


# Who gets in: each route's surface (a_term.caller_trust), for HTTP and the WebSocket. Inside the security headers,
# outside CORS.
app.add_middleware(SurfaceGate)


@app.middleware("http")
async def security_headers(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Add security headers to all responses."""
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Strict-Transport-Security"] = (
        "max-age=31536000; includeSubDomains"
    )
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


# Outermost: nothing else runs for a refused Host.
app.add_middleware(HostGate)

# Include routers: each one's routes are on one caller-trust surface (a_term.caller_trust).
mount(app, a_term.router, Surface.BROWSER)
mount(app, internal.router, Surface.INTERNAL)
mount(app, auth.router, Surface.PUBLIC)
mount(app, sessions.router, Surface.BROWSER)
mount(app, panes.router, Surface.BROWSER)
mount(app, projects.router, Surface.BROWSER)
mount(app, agent.router, Surface.BROWSER)
mount(app, agent_tools.router, Surface.BROWSER)
mount(app, memory_policy.router, Surface.BROWSER)
mount(app, files.router, Surface.BROWSER)
mount(app, shows.router, Surface.BROWSER)
mount(app, pane_files.router, Surface.BROWSER)
mount(app, diagnostics.router, Surface.BROWSER)
mount(app, root_control.router, Surface.CLI_LOCAL)


@app.get("/metrics", response_model=None)
async def metrics() -> dict:
    """Production metrics endpoint."""
    from .services.metrics import get_metrics

    return get_metrics().to_dict()


def _tether_health() -> dict[str, object]:
    client = get_client()
    try:
        version_info = client.require_api_version(MIN_API_VERSION)
        health_info = client.health()
    except TetherVersionError as error:
        return {"status": "incompatible", "error": str(error), "socket": client.socket_path}
    except TetherUnavailable:
        return {"status": "down", "socket": client.socket_path}
    except TetherError as error:
        return {"status": "error", "code": error.code, "socket": client.socket_path}
    return {
        "status": "ok",
        "apiVersion": version_info.get("apiVersion"),
        "version": version_info.get("version"),
        "health": health_info.get("status") if isinstance(health_info, dict) else None,
    }


@app.get("/health", response_model=None)
async def health() -> dict[str, object] | JSONResponse:
    """Healthy when Tether answers with a compatible API and tmux responds."""
    checks: dict[str, object] = {"service": "a-term"}
    tether = await asyncio.to_thread(_tether_health)
    checks["tether"] = tether

    # The user's own sessions live on the default tmux server. A failure here
    # only means it has no sessions, which is fine.
    tmux_ok, _ = await asyncio.to_thread(run_tmux_command, ["list-sessions"])
    checks["tmux"] = "ok" if tmux_ok else "no_sessions"
    checks["maintenance"] = get_maintenance_status(app)

    if tether.get("status") != "ok":
        logger.error("health_check_tether_failed", **{k: v for k, v in tether.items() if k != "socket"})
        return JSONResponse(status_code=503, content={**checks, "status": "unhealthy"})
    checks["status"] = "healthy"
    return checks


# The app's own routes (FastAPI's docs and these two).
declare(
    app,
    {
        "/openapi.json": Surface.BROWSER,
        "/docs": Surface.BROWSER,
        "/docs/oauth2-redirect": Surface.BROWSER,
        "/redoc": Surface.BROWSER,
        "/metrics": Surface.BROWSER,
        "/health": Surface.PUBLIC,
    },
)


def main() -> None:
    """Run the a_term service."""
    uvicorn.run(
        "a_term.main:app",
        host=A_TERM_BIND_HOST,
        port=A_TERM_PORT,
        log_level="info",
        ws_per_message_deflate=True,
    )


if __name__ == "__main__":
    main()
