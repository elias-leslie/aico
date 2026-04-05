"""Close-session service that preserves pane detach semantics."""

from __future__ import annotations

from typing import Any

from ..storage import panes as pane_store
from ..storage import sessions as aterm_store
from ..utils.tmux import get_external_agent_tmux_session, run_tmux_command
from .lifecycle import delete_session as delete_managed_session


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


def _should_clean_pane(closed_mode: str, remaining_sessions: list[dict[str, Any]]) -> bool:
    """Return True when the pane and its companions should be deleted.

    An agent close cleans up shell companions so the whole pane goes away.
    """
    if not remaining_sessions:
        return True
    only_shells_remain = all(
        str(s.get("mode") or "shell") == "shell" for s in remaining_sessions
    )
    return closed_mode != "shell" and only_shells_remain


def _clean_pane_with_companions(
    session_ref: str,
    remaining_sessions: list[dict[str, Any]],
    pane_id: str,
) -> dict[str, Any]:
    """Delete companion sessions and the pane, then return a closed result."""
    for s in remaining_sessions:
        delete_managed_session(str(s["id"]))
    pane_store.delete_pane(pane_id)
    return _build_result(session_ref, pane_id=pane_id, pane_deleted=True)


def _promote_next_session(
    session_ref: str,
    pane: dict[str, Any],
    pane_id: str,
    remaining_sessions: list[dict[str, Any]],
) -> dict[str, Any]:
    """Sync active mode and return next-session info for the surviving pane."""
    next_session = remaining_sessions[0]
    next_mode = str(next_session.get("mode") or "shell")
    if pane.get("active_mode") != next_mode:
        pane_store.update_pane(pane_id, active_mode=next_mode)
    return _build_result(
        session_ref,
        next_session_id=None if pane.get("is_detached") else str(next_session["id"]),
        pane_id=pane_id,
        pane_deleted=False,
    )


def close_session(session_ref: str) -> dict[str, Any]:
    """Close an external or managed aterm session."""
    external_session = get_external_agent_tmux_session(session_ref)
    if external_session:
        tmux_session_name = external_session.get("tmux_session_name") or session_ref
        run_tmux_command(["kill-session", "-t", str(tmux_session_name)])
        return _build_result(session_ref, is_external=True)

    session = aterm_store.get_session(session_ref)
    if not session:
        return _build_result(session_ref)

    pane_id = session.get("pane_id")
    pane = pane_store.get_pane_with_sessions(pane_id) if pane_id else None

    delete_managed_session(session_ref)

    if not pane or not pane_id:
        return _build_result(session_ref)

    remaining_sessions = [
        pane_session
        for pane_session in pane.get("sessions", [])
        if pane_session.get("id") != session_ref
    ]

    closed_mode = str(session.get("mode") or "shell")
    if _should_clean_pane(closed_mode, remaining_sessions):
        return _clean_pane_with_companions(session_ref, remaining_sessions, pane_id)

    return _promote_next_session(session_ref, pane, pane_id, remaining_sessions)
