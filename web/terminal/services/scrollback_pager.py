"""Demand-paged scrollback via targeted tmux capture-pane ranges.

Provides instant connects by sending only the viewport initially, then
lazy-loading scrollback history on demand via scroll_request messages.
"""

from __future__ import annotations

import re

from ..logging_config import get_logger
from ..utils.tmux import run_tmux_command, validate_session_name

logger = get_logger(__name__)

MAX_PAGE_SIZE = 5000  # max lines per scroll_request


def get_scrollback_line_count(session_name: str) -> int | None:
    """Return the total history_size for the session, or None on failure."""
    if not validate_session_name(session_name):
        return None
    ok, output = run_tmux_command(
        ["display-message", "-t", session_name, "-p", "#{history_size}"],
    )
    if not ok or not output:
        return None
    m = re.search(r"(\d+)", output.strip())
    return int(m.group(1)) if m else None


def get_scrollback_range(
    session_name: str,
    from_line: int,
    count: int,
) -> tuple[list[str], int] | None:
    """Capture a range of scrollback lines from tmux.

    Args:
        session_name: tmux session name.
        from_line: 0-based line offset from the start of scrollback.
        count: number of lines to capture (clamped to MAX_PAGE_SIZE).

    Returns:
        (lines, total_lines) or None on failure.
    """
    if not validate_session_name(session_name):
        return None
    count = min(count, MAX_PAGE_SIZE)
    total = get_scrollback_line_count(session_name)
    if total is None:
        return None

    # tmux capture-pane uses negative indices: -S (start from scrollback top)
    # Negative values count from the top of scrollback.
    # -S -N means "start N lines before the current position".
    # We convert our 0-based from_line into tmux's coordinate system.

    # Total visible = history_size + viewport rows. We want lines from
    # the top of history, but tmux's -S/-E are relative to viewport bottom.
    # Use -S {start} -E {end} where negative = scrollback, 0 = top of viewport.

    # Simpler approach: capture entire scrollback and slice.
    # For targeted capture, tmux uses -S (start line) -E (end line) where
    # negative values go into scrollback. -S -{total} = very top.

    start = -(total - from_line)

    # Clamp start to valid range
    if start > 0:
        start = 0

    # Omit -E entirely: #{history_size} only counts off-screen scrollback,
    # so calculated end values exclude the visible viewport. Without -E,
    # tmux captures from start through the current viewport, which is what
    # the overlay needs to show the latest content.
    ok, output = run_tmux_command(
        ["capture-pane", "-t", session_name, "-p", "-e", "-S", str(start)],
    )
    if not ok:
        return None

    result_lines: list[str] = [str(s) for s in (output or "").split("\n")]
    # Remove trailing empty line from capture-pane output
    if result_lines and result_lines[-1] == "":
        result_lines.pop()

    return result_lines, total


def get_viewport_lines(
    session_name: str,
    rows: int,
) -> tuple[str, int, int] | None:
    """Capture the current viewport content.

    Args:
        session_name: tmux session name.
        rows: number of viewport rows.

    Returns:
        (viewport_text, total_lines, viewport_start_line) or None.
    """
    if not validate_session_name(session_name):
        return None

    total = get_scrollback_line_count(session_name)
    if total is None:
        return None

    # Capture visible pane (no -S/-E = current viewport)
    ok, output = run_tmux_command(
        ["capture-pane", "-t", session_name, "-p"],
    )
    if not ok:
        return None

    viewport_text = output or ""
    viewport_start_line = total  # viewport starts after scrollback

    return viewport_text, total, viewport_start_line
