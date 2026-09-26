"""Close-session service that preserves pane detach semantics."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import httpx

from ..storage import panes as pane_store
from ..storage import sessions as a_term_store
from ..utils.tmux import get_external_agent_tmux_session
from .lifecycle import delete_session as delete_managed_session

_AICO_WIDGET_SESSION = re.compile(r"^aico-([0-9a-f]{8})$")


class SessionOwnerError(Exception):
    """The owning application could not safely end a session."""

    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def _aico_control_socket() -> Path:
    configured = os.environ.get("AICO_CONTROL_SOCKET")
    if configured:
        return Path(configured).expanduser()
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return Path(runtime_dir) / "aico" / "control.sock"


def _end_aico_session(session_ref: str, external: dict[str, Any]) -> dict[str, Any]:
    session_name = external.get("tmux_session_name")
    match = _AICO_WIDGET_SESSION.fullmatch(session_name) if isinstance(session_name, str) else None
    source = external.get("tmux_source")
    if (
        not match
        or not isinstance(source, str)
        or not re.fullmatch(r"aico-[0-9a-f]{8,64}", source)
    ):
        raise SessionOwnerError(409, "Session owner is unknown; end it in its owning app")
    session_id = external.get("tmux_session_id")
    pane_id = external.get("tmux_pane_id")
    if (
        not isinstance(session_id, str)
        or not session_id.startswith("$")
        or not isinstance(pane_id, str)
        or not pane_id.startswith("%")
    ):
        raise SessionOwnerError(409, "Aico session generation is unknown; refresh the session before ending it")

    endpoint = f"http://localhost/v1/sessions/{match.group(1)}"
    end_requested = False
    try:
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(_aico_control_socket())), timeout=3.0) as client:
            owner = client.get(endpoint)
            if owner.status_code != 200:
                status = 409 if owner.status_code in {404, 409} else 503
                raise SessionOwnerError(status, "Aico cannot verify ownership; session was preserved")
            try:
                descriptor = owner.json()
            except ValueError as error:
                raise SessionOwnerError(503, "Aico returned an invalid owner response; session was preserved") from error
            generation = descriptor.get("generation") if isinstance(descriptor, dict) else None
            if (
                not isinstance(descriptor, dict)
                or descriptor.get("owner") != "aico"
                or descriptor.get("widgetId") != match.group(1)
                or descriptor.get("tmuxSessionId") != session_id
                or descriptor.get("paneId") != pane_id
                or not isinstance(generation, str)
                or not generation
            ):
                raise SessionOwnerError(409, "Aico session changed; refresh the session before ending it")
            end_requested = True
            ended = client.post(f"{endpoint}/end", json={"generation": generation})
            if ended.status_code != 200:
                status = 409 if ended.status_code in {404, 409} else 503
                raise SessionOwnerError(status, "Aico could not confirm End; refresh the session before retrying")
            try:
                result = ended.json()
            except ValueError as error:
                raise SessionOwnerError(503, "Aico returned an invalid end response; verify the session before retrying") from error
            if not isinstance(result, dict) or result.get("status") != "ended":
                raise SessionOwnerError(503, "Aico did not confirm the session ended; verify it before retrying")
    except httpx.HTTPError as error:
        detail = (
            "Aico owner service did not confirm End; refresh the session before retrying"
            if end_requested
            else "Aico owner service is unavailable; session was preserved. Start the Aico owner service and retry"
        )
        raise SessionOwnerError(503, detail) from error
    return _build_result(session_ref, is_external=True)


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


def close_session(
    session_ref: str,
    *,
    expected_tmux_session_id: str | None = None,
) -> dict[str, Any]:
    """Close an external or managed a_term session."""
    external_session = get_external_agent_tmux_session(session_ref)
    if external_session:
        return _end_aico_session(session_ref, external_session)

    session = a_term_store.get_session(session_ref)
    if not session:
        return _build_result(session_ref)

    pane_id = session.get("pane_id")
    pane = pane_store.get_pane_with_sessions(pane_id) if pane_id else None

    if expected_tmux_session_id is None:
        delete_managed_session(session_ref)
    else:
        delete_managed_session(session_ref, expected_tmux_session_id=expected_tmux_session_id)

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
