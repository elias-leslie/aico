"""Scrollback synchronization — diff tracking, payload building, and scheduling.

Provides three layers:
1. LineDiffTracker — line-level deltas between successive tmux snapshots
   (replaces 192KB bulk snapshots with ~90% smaller delta messages).
2. Payload helpers — normalize, bound, and serialize scrollback for transport.
3. ScrollbackSyncScheduler — debounced async loop that captures tmux state and
   sends full or delta payloads to the WebSocket client.

Implementation lives in adjacent private modules:
- _line_diff.py       — LineEntry, ScrollbackDelta, LineDiffTracker
- _scrollback_payload.py — normalize/limit/prepare/build helpers
- _sync_scheduler.py  — ScrollbackSyncOutputTracker, ScrollbackSyncScheduler
"""

from ._line_diff import HEAD_HASH_COUNT as HEAD_HASH_COUNT
from ._line_diff import LineDiffTracker, LineEntry, ScrollbackDelta, _split_lines
from ._scrollback_payload import (
    MAX_SCROLLBACK_CHARS,
    _make_scrollback_payload,
    build_scrollback_sync_payload,
    limit_scrollback,
    normalize_scrollback,
    prepare_scrollback_for_transport,
)
from ._sync_scheduler import (
    SCROLLBACK_SYNC_DELAY_SECONDS,
    SCROLLBACK_SYNC_QUIET_SECONDS,
    SCROLLBACK_SYNC_STALENESS_SECONDS,
    ScrollbackSyncOutputTracker,
    ScrollbackSyncScheduler,
)

__all__ = [
    "HEAD_HASH_COUNT",
    "MAX_SCROLLBACK_CHARS",
    "SCROLLBACK_SYNC_DELAY_SECONDS",
    "SCROLLBACK_SYNC_QUIET_SECONDS",
    "SCROLLBACK_SYNC_STALENESS_SECONDS",
    "LineDiffTracker",
    "LineEntry",
    "ScrollbackDelta",
    "ScrollbackSyncOutputTracker",
    "ScrollbackSyncScheduler",
    "_make_scrollback_payload",
    "_split_lines",
    "build_scrollback_sync_payload",
    "limit_scrollback",
    "normalize_scrollback",
    "prepare_scrollback_for_transport",
]
