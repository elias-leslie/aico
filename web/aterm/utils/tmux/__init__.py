"""tmux session management utilities.

Provides core tmux operations: session naming, existence checks, creation,
listing, scrollback capture, and window resizing.

Public API is intentionally flat — all names are importable from
``aterm.utils.tmux`` exactly as before the package split.
"""

from __future__ import annotations

# Re-export subprocess and uuid so tests can patch aterm.utils.tmux.subprocess
# and aterm.utils.tmux._uuid_mod without changes.
import subprocess  # noqa: F401
import uuid as _uuid_mod  # noqa: F401

from ...config import TMUX_DEFAULT_COLS, TMUX_DEFAULT_ROWS  # noqa: F401
from .core import (
    _SESSION_NAME_PATTERN,  # noqa: F401
    FILTERED_ENV_VARS,
    TMUX_COMMAND_TIMEOUT,
    TMUX_SESSION_PREFIX,
    TmuxError,
    run_tmux_command,
    validate_session_name,
)
from .external import (
    _EXTERNAL_AGENT_TOKENS,  # noqa: F401
    _EXTERNAL_ATTACH_LOCK,  # noqa: F401
    _EXTERNAL_ATTACH_STATES,  # noqa: F401
    _ExternalAttachState,  # noqa: F401
    _infer_external_mode,  # noqa: F401
    _infer_project_id,  # noqa: F401
    _normalize_tmux_toggle,  # noqa: F401
    apply_external_attach_options,
    get_external_agent_tmux_session,
    get_tmux_session_option,
    list_external_agent_tmux_sessions,
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
    _apply_session_options,  # noqa: F401
    _can_spawn_tmux_scope,  # noqa: F401
    _is_valid_uuid,  # noqa: F401
    _run_tmux_new_session,  # noqa: F401
    create_tmux_session,
    get_tmux_session_name,
    is_managed_tmux_session_name,
    list_tmux_sessions,
    tmux_session_exists,
    tmux_session_exists_by_name,
)
from .window import reset_tmux_window_size_policy, resize_tmux_window

__all__ = [
    "FILTERED_ENV_VARS",
    "TMUX_COMMAND_TIMEOUT",
    "TMUX_SESSION_PREFIX",
    "TmuxError",
    "apply_external_attach_options",
    "create_tmux_session",
    "get_cursor_position",
    "get_external_agent_tmux_session",
    "get_scrollback",
    "get_scrollback_with_cursor",
    "get_tmux_session_name",
    "get_tmux_session_option",
    "is_managed_tmux_session_name",
    "list_external_agent_tmux_sessions",
    "list_tmux_sessions",
    "reset_tmux_window_size_policy",
    "resize_tmux_window",
    "restore_external_attach_options",
    "run_tmux_command",
    "set_tmux_session_option",
    "tmux_session_exists",
    "tmux_session_exists_by_name",
    "validate_session_name",
]
