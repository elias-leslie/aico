"""Tmux window sizing and size-policy management."""

from __future__ import annotations

import sys

from ...logging_config import get_logger

logger = get_logger(__name__)


def _pkg() -> object:
    """Return the aterm.utils.tmux package module (avoids circular import)."""
    return sys.modules["aterm.utils.tmux"]


def resize_tmux_window(session_name: str, cols: int, rows: int) -> bool:
    """Resize tmux window to match frontend dimensions."""
    pkg = _pkg()
    success, _ = pkg.run_tmux_command(  # type: ignore[union-attr]
        ["resize-window", "-t", session_name, "-x", str(cols), "-y", str(rows)]
    )

    if success:
        logger.debug("tmux_window_resized", session=session_name, cols=cols, rows=rows)
    else:
        logger.warning("tmux_window_resize_failed", session=session_name, cols=cols, rows=rows)
    return success


def reset_tmux_window_size_policy(session_name: str) -> bool:
    """Return a tmux window to client-driven sizing.

    External shared sessions should not remain pinned to a manual geometry after
    A-Term disconnects. `window-size latest` lets the active tmux client
    reclaim its own size instead of preserving a stale manual resize.
    """
    pkg = _pkg()
    success, _ = pkg.run_tmux_command(  # type: ignore[union-attr]
        ["set-window-option", "-t", session_name, "window-size", "latest"]
    )
    if success:
        logger.debug("tmux_window_size_policy_reset", session=session_name, policy="latest")
    else:
        logger.warning("tmux_window_size_policy_reset_failed", session=session_name)
    return success
