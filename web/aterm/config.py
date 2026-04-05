"""Centralized configuration loading.

Uses pydantic-settings for validated configuration with environment variable support.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .branding import BACKEND_PORT, FRONTEND_PORT, REPO_ROOT, get_recordings_dir, get_upload_dir

# ---------------------------------------------------------------------------
# Port allocation — single source of truth for A-Term.
# ---------------------------------------------------------------------------
ATERM_BACKEND_PORT = BACKEND_PORT
ATERM_FRONTEND_PORT = FRONTEND_PORT
SUMMITFLOW_BACKEND_PORT = 8001


class Settings(BaseSettings):
    """Application settings loaded from environment variables.

    Loads from repo-local env files first, then falls back to ~/.env.local for
    the internal shared environment.
    """

    model_config = SettingsConfigDict(
        env_file=(
            str(REPO_ROOT / ".env.local"),
            str(REPO_ROOT / ".env"),
            str(Path.home() / ".env.local"),
        ),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Database
    database_url: str = ""
    db_pool_min_size: int = 2
    db_pool_max_size: int = 10
    db_pool_timeout_seconds: float = 10.0
    db_pool_max_waiting: int = 20
    db_pool_max_lifetime_seconds: float = 1800.0
    db_pool_max_idle_seconds: float = 300.0
    db_pool_reconnect_timeout_seconds: float = 30.0

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, v: str) -> str:
        """Ensure database_url is provided."""
        if not v:
            raise ValueError("DATABASE_URL environment variable is required")
        return v

    # A-Term service
    aterm_port: int = ATERM_BACKEND_PORT

    # CORS
    cors_origins: list[str] = [
        f"http://localhost:{ATERM_FRONTEND_PORT}",
    ]

    # A-Term dimensions
    tmux_default_cols: int = 120
    tmux_default_rows: int = 30
    tmux_min_cols: int = 1
    tmux_max_cols: int = 512
    tmux_min_rows: int = 1
    tmux_max_rows: int = 256

    # File upload configuration
    max_file_size_mb: int = 10
    upload_dir: Path = get_upload_dir()
    upload_max_age_seconds: int = 24 * 60 * 60

    # Optional integrations
    summitflow_api_base: str = ""

    # Diagnostics & recording
    diagnostics_enabled: bool = False
    recording_enabled: bool = False
    recording_dir: Path = get_recordings_dir()
    recording_max_size_mb: int = 100

    # Maintenance
    maintenance_enabled: bool = True
    maintenance_interval_seconds: int = 15 * 60
    maintenance_session_purge_days: int = 7

    @property
    def max_file_size(self) -> int:
        """Maximum file size in bytes."""
        return self.max_file_size_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance.

    Returns:
        Settings instance (cached for performance)
    """
    return Settings()


# Pre-loaded for modules that need them at import time
# These provide backward compatibility with existing code
settings = get_settings()
DATABASE_URL = settings.database_url
DB_POOL_MIN_SIZE = settings.db_pool_min_size
DB_POOL_MAX_SIZE = settings.db_pool_max_size
DB_POOL_TIMEOUT_SECONDS = settings.db_pool_timeout_seconds
DB_POOL_MAX_WAITING = settings.db_pool_max_waiting
DB_POOL_MAX_LIFETIME_SECONDS = settings.db_pool_max_lifetime_seconds
DB_POOL_MAX_IDLE_SECONDS = settings.db_pool_max_idle_seconds
DB_POOL_RECONNECT_TIMEOUT_SECONDS = settings.db_pool_reconnect_timeout_seconds
ATERM_PORT = settings.aterm_port
CORS_ORIGINS = settings.cors_origins
TMUX_DEFAULT_COLS = settings.tmux_default_cols
TMUX_DEFAULT_ROWS = settings.tmux_default_rows
TMUX_MIN_COLS = settings.tmux_min_cols
TMUX_MAX_COLS = settings.tmux_max_cols
TMUX_MIN_ROWS = settings.tmux_min_rows
TMUX_MAX_ROWS = settings.tmux_max_rows
MAX_FILE_SIZE_MB = settings.max_file_size_mb
MAX_FILE_SIZE = settings.max_file_size
UPLOAD_DIR = settings.upload_dir
UPLOAD_MAX_AGE_SECONDS = settings.upload_max_age_seconds
SUMMITFLOW_API_BASE = settings.summitflow_api_base
MAINTENANCE_ENABLED = settings.maintenance_enabled
MAINTENANCE_INTERVAL_SECONDS = settings.maintenance_interval_seconds
MAINTENANCE_SESSION_PURGE_DAYS = settings.maintenance_session_purge_days
