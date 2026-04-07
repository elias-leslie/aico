"""Database connection management for A-Term Service."""

import threading
import uuid
from collections.abc import Generator
from contextlib import contextmanager

import psycopg
from psycopg_pool import ConnectionPool

from ..config import (
    DATABASE_URL,
    DB_POOL_MAX_IDLE_SECONDS,
    DB_POOL_MAX_LIFETIME_SECONDS,
    DB_POOL_MAX_SIZE,
    DB_POOL_MAX_WAITING,
    DB_POOL_MIN_SIZE,
    DB_POOL_RECONNECT_TIMEOUT_SECONDS,
    DB_POOL_TIMEOUT_SECONDS,
)

# Module-level pool with thread-safe initialization
_pool: ConnectionPool | None = None
_pool_lock = threading.Lock()


def _create_pool() -> ConnectionPool:
    """Create a new connection pool. Caller must hold _pool_lock."""
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL must be set")
    return ConnectionPool(
        conninfo=DATABASE_URL,
        min_size=DB_POOL_MIN_SIZE,
        max_size=DB_POOL_MAX_SIZE,
        check=ConnectionPool.check_connection,
        open=True,
        timeout=DB_POOL_TIMEOUT_SECONDS,
        max_waiting=DB_POOL_MAX_WAITING,
        max_lifetime=DB_POOL_MAX_LIFETIME_SECONDS,
        max_idle=DB_POOL_MAX_IDLE_SECONDS,
        reconnect_timeout=DB_POOL_RECONNECT_TIMEOUT_SECONDS,
    )


def _get_pool() -> ConnectionPool:
    """Lazily initialize and return the connection pool."""
    global _pool
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is None:
            _pool = _create_pool()
    return _pool


@contextmanager
def get_connection() -> Generator[psycopg.Connection]:
    """Get a database connection from the pool.

    Usage:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
    """
    pool = _get_pool()
    with pool.connection() as conn:
        yield conn


@contextmanager
def get_cursor() -> Generator[psycopg.Cursor]:
    """Get a cursor for read-mostly helpers."""
    with get_connection() as conn, conn.cursor() as cur:
        yield cur


def generate_prefixed_id(prefix: str) -> str:
    """Generate a short prefixed identifier."""
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def close_pool() -> None:
    """Close the connection pool (for graceful shutdown)."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def advisory_lock(lock_key: int) -> Generator[bool]:
    """Hold a PostgreSQL advisory lock for the duration of the context."""
    pool = _get_pool()
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s)", (lock_key,))
        row = cur.fetchone()
        acquired = bool(row and row[0])
        try:
            yield acquired
        finally:
            if acquired:
                cur.execute("SELECT pg_advisory_unlock(%s)", (lock_key,))
