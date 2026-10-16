"""Resolve a session into an attach plan for a WebSocket view.

The session catalog owns attach plans (:func:`session_catalog.attach_plan`):
Tether sessions attach with the exact argv Tether hands out, Legacy and Own
tmux sessions on the default tmux server. This module keeps the name the
WebSocket handlers and their tests call.
"""

from __future__ import annotations

from ...services import session_catalog
from ...services.session_catalog import AttachPlan

__all__ = ["AttachPlan", "validate_and_prepare_session"]


def validate_and_prepare_session(session_id: str) -> AttachPlan:
    """Resolve ``session_id`` to an attach plan (see :func:`session_catalog.attach_plan`)."""
    return session_catalog.attach_plan(session_id)
