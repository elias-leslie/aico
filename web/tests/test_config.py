"""Tests for a_term configuration loading.

Verifies that environment variables are correctly parsed into
configuration constants.
"""

from __future__ import annotations

import importlib
from unittest.mock import patch

import pytest


def test_config_database_url_required_raises_on_missing() -> None:
    """Config module -- missing DATABASE_URL raises ValueError."""
    # Arrange & Act & Assert
    with (
        patch.dict("os.environ", {"DATABASE_URL": ""}, clear=False),
        pytest.raises(ValueError, match="DATABASE_URL"),
    ):
            import a_term.config as cfg
            cfg.get_settings.cache_clear()
            importlib.reload(cfg)


def test_config_a_term_port_default_is_8002() -> None:
    """Config module -- A_TERM_PORT defaults to 8002."""
    # Arrange & Act
    with patch.dict(
        "os.environ",
        {"DATABASE_URL": "postgresql://test:test@localhost/test"},
        clear=False,
    ):
        import a_term.config as cfg
        cfg.get_settings.cache_clear()
        importlib.reload(cfg)

    # Assert
    assert cfg.A_TERM_PORT == 8002


def test_config_a_term_port_custom_from_env() -> None:
    """Config module -- A_TERM_PORT reads from environment."""
    # Arrange & Act
    with patch.dict(
        "os.environ",
        {
            "DATABASE_URL": "postgresql://test:test@localhost/test",
            "A_TERM_PORT": "9999",
        },
        clear=False,
    ):
        import a_term.config as cfg
        cfg.get_settings.cache_clear()
        importlib.reload(cfg)

    # Assert
    assert cfg.A_TERM_PORT == 9999


def test_config_tmux_dimension_constants() -> None:
    """Config module -- tmux dimension constants are present and valid."""
    # Arrange & Act
    with patch.dict(
        "os.environ",
        {"DATABASE_URL": "postgresql://test:test@localhost/test"},
        clear=False,
    ):
        import a_term.config as cfg
        cfg.get_settings.cache_clear()
        importlib.reload(cfg)

    # Assert
    assert cfg.TMUX_DEFAULT_COLS == 120
    assert cfg.TMUX_DEFAULT_ROWS == 30
    assert cfg.TMUX_MIN_COLS >= 1
    assert cfg.TMUX_MAX_COLS <= 1024
    assert cfg.TMUX_MIN_ROWS >= 1
    assert cfg.TMUX_MAX_ROWS <= 512


def test_config_cors_origins_splits_comma_separated() -> None:
    """Config module -- CORS_ORIGINS accepts JSON array from env."""
    # Arrange & Act — pydantic-settings expects JSON for list[str] fields
    with patch.dict(
        "os.environ",
        {
            "DATABASE_URL": "postgresql://test:test@localhost/test",
            "CORS_ORIGINS": '["http://localhost:3000","http://localhost:3002"]',
        },
        clear=False,
    ):
        import a_term.config as cfg
        cfg.get_settings.cache_clear()
        importlib.reload(cfg)

    # Assert
    assert isinstance(cfg.CORS_ORIGINS, list)
    assert len(cfg.CORS_ORIGINS) == 2
    assert "http://localhost:3000" in cfg.CORS_ORIGINS
    assert "http://localhost:3002" in cfg.CORS_ORIGINS


def test_config_maintenance_and_pool_settings_from_env() -> None:
    """Config module -- maintenance and DB pool settings are configurable."""
    with patch.dict(
        "os.environ",
        {
            "DATABASE_URL": "postgresql://test:test@localhost/test",
            "DB_POOL_MIN_SIZE": "3",
            "DB_POOL_MAX_SIZE": "12",
            "MAINTENANCE_INTERVAL_SECONDS": "120",
            "MAINTENANCE_SESSION_PURGE_DAYS": "14",
            "UPLOAD_MAX_AGE_SECONDS": "1800",
        },
        clear=False,
    ):
        import a_term.config as cfg
        cfg.get_settings.cache_clear()
        importlib.reload(cfg)

    assert cfg.DB_POOL_MIN_SIZE == 3
    assert cfg.DB_POOL_MAX_SIZE == 12
    assert cfg.MAINTENANCE_INTERVAL_SECONDS == 120
    assert cfg.MAINTENANCE_SESSION_PURGE_DAYS == 14
    assert cfg.UPLOAD_MAX_AGE_SECONDS == 1800
