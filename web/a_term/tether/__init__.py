"""Tether client: A-Term's only path to session lifecycle, tools, projects and roots."""

from .client import (
    MIN_API_VERSION,
    TetherClient,
    TetherError,
    TetherResponse,
    TetherUnavailable,
    TetherVersionError,
    default_socket_path,
    get_client,
    set_client,
)

__all__ = [
    "MIN_API_VERSION",
    "TetherClient",
    "TetherError",
    "TetherResponse",
    "TetherUnavailable",
    "TetherVersionError",
    "default_socket_path",
    "get_client",
    "set_client",
]
