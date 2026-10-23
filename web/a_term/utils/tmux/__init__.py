"""tmux helpers for attaching to sessions A-Term shows.

Tether creates and ends sessions on private servers; A-Term only attaches,
captures and toggles view options, always against the session's own socket.
The user's own default-server sessions are reached with ``socket_name=None``.

Public API is intentionally flat: import names from ``a_term.utils.tmux``.
"""

from __future__ import annotations

# Re-export subprocess so tests can patch a_term.utils.tmux.subprocess.
import subprocess  # noqa: F401

from .core import (
    _SESSION_NAME_PATTERN,  # noqa: F401
    TMUX_COMMAND_TIMEOUT,
    TmuxError,
    build_tmux_command,
    run_tmux_command,
    validate_session_name,
    validate_socket_name,
)
from .external import (
    _EXTERNAL_ATTACH_LOCK,  # noqa: F401
    _EXTERNAL_ATTACH_STATES,  # noqa: F401
    _ExternalAttachState,  # noqa: F401
    _normalize_tmux_toggle,  # noqa: F401
    apply_external_attach_options,
    get_tmux_session_option,
    restore_external_attach_options,
    set_tmux_session_option,
)
from .window import reset_tmux_window_size_policy

__all__ = [
    "TMUX_COMMAND_TIMEOUT",
    "TmuxError",
    "apply_external_attach_options",
    "build_tmux_command",
    "get_tmux_session_option",
    "reset_tmux_window_size_policy",
    "restore_external_attach_options",
    "run_tmux_command",
    "set_tmux_session_option",
    "validate_session_name",
    "validate_socket_name",
]
