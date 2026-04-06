"""Payload helpers — normalize, bound, and serialize scrollback for transport."""

from __future__ import annotations

import json
from typing import Any

MAX_SCROLLBACK_CHARS = 192_000


def normalize_scrollback(scrollback: str) -> str:
    """Normalize tmux capture-pane output for xterm consumption."""
    return scrollback.replace("\r\n", "\n").replace("\n", "\r\n")


def limit_scrollback(scrollback: str, max_chars: int = MAX_SCROLLBACK_CHARS) -> str:
    """Trim large scrollback payloads to the newest tail for browser transport."""
    if max_chars <= 0 or len(scrollback) <= max_chars:
        return scrollback
    trimmed = scrollback[-max_chars:]
    first_newline = trimmed.find("\n")
    if first_newline == -1:
        return trimmed
    return trimmed[first_newline + 1:]


def prepare_scrollback_for_transport(
    scrollback: str,
    max_chars: int = MAX_SCROLLBACK_CHARS,
) -> str:
    """Normalize and bound tmux scrollback before sending it to the browser."""
    return limit_scrollback(normalize_scrollback(scrollback), max_chars=max_chars)


def _make_scrollback_payload(
    scrollback_data: str,
    cursor_position: tuple[int, int] | None = None,
) -> dict[str, Any]:
    """Return the canonical scrollback-sync control dict."""
    payload: dict[str, Any] = {"__ctrl": True, "scrollback_sync": scrollback_data}
    if cursor_position is not None:
        cursor_x, cursor_y = cursor_position
        payload["scrollback_cursor_x"] = cursor_x
        payload["scrollback_cursor_y"] = cursor_y
    return payload


def build_scrollback_sync_payload(
    scrollback: str,
    cursor_position: tuple[int, int] | None = None,
) -> str:
    return json.dumps(_make_scrollback_payload(prepare_scrollback_for_transport(scrollback), cursor_position))
