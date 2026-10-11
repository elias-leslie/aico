"""End a session from A-Term while keeping the pane's view semantics.

Ending goes through Tether for every Tether session, whichever app created
it (there is no cross-app owner any more). A legacy default-server session is
ended with an exact ``kill-session``. The user's own default-server sessions
are never ended from A-Term: closing one only detaches A-Term's view.
"""

from __future__ import annotations

from typing import Any

from ..storage import panes as pane_store
from . import lifecycle, session_catalog


def _build_result(
    session_id: str,
    *,
    next_session_id: str | None = None,
    pane_id: str | None = None,
    pane_deleted: bool = False,
    is_external: bool = False,
) -> dict[str, Any]:
    return {
        "deleted": True,
        "id": session_id,
        "next_session_id": next_session_id,
        "pane_id": pane_id,
        "pane_deleted": pane_deleted,
        "is_external": is_external,
    }


def _should_clean_pane(closed_mode: str, remaining_links: list[dict[str, Any]]) -> bool:
    """An agent close also ends shell companions, so the whole pane goes away."""
    if not remaining_links:
        return True
    only_shells_remain = all(str(link.get("mode") or "shell") == "shell" for link in remaining_links)
    return closed_mode != "shell" and only_shells_remain


def close_session(session_id: str) -> dict[str, Any]:
    """End a session and update the pane that showed it."""
    if not (session_catalog.is_tether_id(session_id) or session_catalog.is_legacy_id(session_id)):
        # The user's own tmux session: A-Term only had a view of it.
        return _build_result(session_id, is_external=True)

    link = pane_store.get_link(session_id)
    lifecycle.end_session(session_id)
    if link is None:
        return _build_result(session_id, is_external=True)

    pane_id = str(link["pane_id"])
    pane = pane_store.get_pane(pane_id)
    if pane is None:
        return _build_result(session_id)
    remaining = pane_store.links_for_pane(pane_id)
    if _should_clean_pane(str(link.get("mode") or "shell"), remaining):
        for companion in remaining:
            lifecycle.end_session(str(companion["session_id"]))
        pane_store.delete_pane(pane_id)
        return _build_result(session_id, pane_id=pane_id, pane_deleted=True)

    next_link = remaining[0]
    next_mode = str(next_link.get("mode") or "shell")
    if pane.get("active_mode") != next_mode:
        pane_store.update_pane(pane_id, active_mode=next_mode)
    return _build_result(
        session_id,
        next_session_id=None if pane.get("is_detached") else str(next_link["session_id"]),
        pane_id=pane_id,
    )
