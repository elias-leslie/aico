"""Rate limiting configuration for the Terminal API.

Uses slowapi with in-memory storage. Rate limits are per-IP.
Default: 60 requests/minute for all endpoints.
Stricter limits applied to mutation endpoints via decorators.
"""

from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(
    key_func=get_remote_address,
    default_limits=["60/minute"],
)
