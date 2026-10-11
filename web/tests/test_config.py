"""Tests for a_term configuration loading.

Verifies that environment variables are correctly parsed into
configuration constants.
"""

from __future__ import annotations

import importlib
from unittest.mock import patch


def test_config_needs_no_database() -> None:
    """A-Term has no database server: settings load with no DATABASE_URL at all."""
    with patch.dict("os.environ", {"DATABASE_URL": ""}, clear=False):
        import a_term.config as cfg
        cfg.get_settings.cache_clear()
        importlib.reload(cfg)

    assert not hasattr(cfg, "DATABASE_URL")
    assert not hasattr(cfg.get_settings(), "database_url")
    assert not hasattr(cfg.get_settings(), "a_term_aico_state_dir")


def test_config_a_term_port_default_is_8002() -> None:
    """Config module -- A_TERM_PORT defaults to 8002."""
    # Arrange & Act
    with patch.dict(
        "os.environ",
        {},
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
        {},
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


def test_config_maintenance_settings_from_env() -> None:
    """Config module -- maintenance settings are configurable."""
    with patch.dict(
        "os.environ",
        {
            "MAINTENANCE_INTERVAL_SECONDS": "120",
            "MAINTENANCE_SESSION_PURGE_DAYS": "14",
            "UPLOAD_MAX_AGE_SECONDS": "1800",
        },
        clear=False,
    ):
        import a_term.config as cfg
        cfg.get_settings.cache_clear()
        importlib.reload(cfg)

    assert cfg.MAINTENANCE_INTERVAL_SECONDS == 120
    assert cfg.MAINTENANCE_SESSION_PURGE_DAYS == 14
    assert cfg.UPLOAD_MAX_AGE_SECONDS == 1800
