"""tmux helpers for attaching to sessions A-Term shows.

Tether creates and ends sessions on private servers; A-Term only attaches,
captures and toggles view options, always against the session's own socket.
Legacy ``summitflow-*`` sessions on the user's default server and the user's
own default-server sessions are reached with ``socket_name=None``.

Public API is intentionally flat: import names from ``a_term.utils.tmux``.
"""

from __future__ import annotations

# Re-export subprocess so tests can patch a_term.utils.tmux.subprocess.
import subprocess  # noqa: F401

from .core import (
    _SESSION_NAME_PATTERN,  # noqa: F401
    TMUX_COMMAND_TIMEOUT,
    TMUX_SESSION_PREFIX,
    TmuxError,
    build_tmux_command,
    run_tmux_command,
    validate_session_name,
    validate_socket_name,
)
from .external import (
    _EXTERNAL_AGENT_TOKENS,  # noqa: F401
    _EXTERNAL_ATTACH_LOCK,  # noqa: F401
    _EXTERNAL_ATTACH_STATES,  # noqa: F401
    _EXTERNAL_TMUX_SOURCES,  # noqa: F401
    ExternalTmuxSource,
    _ExternalAttachState,  # noqa: F401
    _infer_external_mode,  # noqa: F401
    _infer_project_id,  # noqa: F401
    _normalize_tmux_toggle,  # noqa: F401
    apply_external_attach_options,
    get_external_agent_tmux_session,
    get_tmux_session_option,
    list_external_agent_tmux_sessions,
    list_external_tmux_sessions,
    restore_external_attach_options,
    set_tmux_session_option,
)
from .scrollback import (
    _CURSOR_SENTINEL,  # noqa: F401
    get_cursor_position,
    get_scrollback,
    get_scrollback_with_cursor,
)
from .sessions import (
    _is_valid_uuid,  # noqa: F401
    get_tmux_session_name,
    is_managed_tmux_session_name,
    kill_legacy_session,
    list_tmux_sessions,
    tmux_session_exists,
    tmux_session_exists_by_name,
)
from .window import reset_tmux_window_size_policy, resize_tmux_window

__all__ = [
    "TMUX_COMMAND_TIMEOUT",
    "TMUX_SESSION_PREFIX",
    "ExternalTmuxSource",
    "TmuxError",
    "apply_external_attach_options",
    "build_tmux_command",
    "get_cursor_position",
    "get_external_agent_tmux_session",
    "get_scrollback",
    "get_scrollback_with_cursor",
    "get_tmux_session_name",
    "get_tmux_session_option",
    "is_managed_tmux_session_name",
    "kill_legacy_session",
    "list_external_agent_tmux_sessions",
    "list_external_tmux_sessions",
    "list_tmux_sessions",
    "reset_tmux_window_size_policy",
    "resize_tmux_window",
    "restore_external_attach_options",
    "run_tmux_command",
    "set_tmux_session_option",
    "tmux_session_exists",
    "tmux_session_exists_by_name",
    "validate_session_name",
    "validate_socket_name",
]
