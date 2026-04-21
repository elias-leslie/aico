"""Tmux scrollback and cursor position capture."""

from __future__ import annotations

import sys

from ...logging_config import get_logger

logger = get_logger(__name__)

# Sentinel that separates capture-pane output from cursor display-message
_CURSOR_SENTINEL = "<<CURSOR>>"


def _is_missing_tmux_target_error(error: str | None) -> bool:
    if not error:
        return False
    lowered = error.lower()
    return (
        lowered.startswith("can't find pane:")
        or lowered.startswith("can't find session:")
        or lowered.startswith("no such pane:")
        or lowered.startswith("no such session:")
    )


def _log_tmux_capture_failure(event: str, session_name: str, error: str | None) -> None:
    if _is_missing_tmux_target_error(error):
        logger.debug(event, session=session_name, error=error)
        return
    logger.warning(event, session=session_name, error=error)


def _pkg() -> object:
    """Return the a_term.utils.tmux package module (avoids circular import)."""
    return sys.modules["a_term.utils.tmux"]


def get_scrollback(session_name: str, max_lines: int = 5000) -> str | None:
    """Capture recent tmux scrollback with color attributes and joined wrapped lines.

    The -e flag adds only SGR (color/attribute) escape sequences — no cursor
    positioning, scroll regions, or mode changes — so it's safe for xterm.js.

    Args:
        session_name: tmux session to capture from
        max_lines: Max lines of history to capture. Limits reconnect payload size
            while providing enough context for meaningful scroll-back on reconnect.
    """
    pkg = _pkg()
    success, output = pkg.run_tmux_command(  # type: ignore[union-attr]
        ["capture-pane", "-t", session_name, "-S", f"-{max_lines}", "-e", "-J", "-p"]
    )

    if not success:
        _log_tmux_capture_failure(
            "tmux_scrollback_capture_failed",
            session_name,
            output,
        )
        return None

    return output


def get_cursor_position(session_name: str) -> tuple[int, int] | None:
    """Return the current tmux cursor position for the active pane."""
    pkg = _pkg()
    success, output = pkg.run_tmux_command(  # type: ignore[union-attr]
        [
            "display-message",
            "-p",
            "-t",
            session_name,
            "#{cursor_x}\t#{cursor_y}",
        ]
    )

    if not success:
        _log_tmux_capture_failure(
            "tmux_cursor_position_failed",
            session_name,
            output,
        )
        return None

    try:
        cursor_x_text, cursor_y_text = output.strip().split("\t", maxsplit=1)
        return int(cursor_x_text), int(cursor_y_text)
    except (TypeError, ValueError):
        logger.warning(
            "tmux_cursor_position_invalid",
            session=session_name,
            output=output,
        )
        return None


def get_scrollback_with_cursor(
    session_name: str,
    max_lines: int = 5000,
) -> tuple[str | None, tuple[int, int] | None]:
    """Capture scrollback and cursor position in a single tmux invocation.

    Uses tmux command chaining (\\;) to run capture-pane and display-message
    atomically, halving subprocess overhead vs two separate calls.

    Returns:
        (scrollback, cursor_position) — either may be None on failure.
    """
    pkg = _pkg()
    # tmux prints capture-pane output first, then display-message output.
    # We use a sentinel to split them reliably.
    success, output = pkg.run_tmux_command([  # type: ignore[union-attr]
        "capture-pane", "-t", session_name,
        "-S", f"-{max_lines}", "-e", "-J", "-p",
        ";",
        "display-message", "-t", session_name,
        "-p", f"{_CURSOR_SENTINEL}#{{cursor_x}}\t#{{cursor_y}}",
    ])

    if not success:
        _log_tmux_capture_failure(
            "tmux_scrollback_with_cursor_failed",
            session_name,
            output,
        )
        return None, None

    # Split on sentinel — everything before is scrollback, after is cursor
    sentinel_idx = output.rfind(_CURSOR_SENTINEL)
    if sentinel_idx == -1:
        # Sentinel missing — capture-pane succeeded but display-message didn't
        return output, None

    scrollback = output[:sentinel_idx].rstrip("\n")
    cursor_part = output[sentinel_idx + len(_CURSOR_SENTINEL):]

    cursor_position: tuple[int, int] | None = None
    try:
        cursor_x_text, cursor_y_text = cursor_part.strip().split("\t", maxsplit=1)
        cursor_position = (int(cursor_x_text), int(cursor_y_text))
    except (TypeError, ValueError):
        logger.warning(
            "tmux_cursor_position_invalid",
            session=session_name,
            output=cursor_part,
        )

    return scrollback, cursor_position
