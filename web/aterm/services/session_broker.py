"""Shared local session broker for A-Term-aware tool launchers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ..branding import get_project_display_name
from ..storage import panes as pane_store
from ..storage import project_settings as project_settings_store
from ..utils.tmux import get_tmux_session_name, tmux_session_exists_by_name
from . import agent_service, lifecycle


@dataclass(frozen=True)
class BrokerSessionTarget:
    """A A-Term-managed session target that local wrappers can attach to."""

    project_id: str
    mode: str
    pane_id: str
    pane_name: str
    session_id: str
    tmux_session_name: str
    working_dir: str | None
    created: bool
    started: bool


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _pane_name_for_project(project_id: str, panes: list[dict[str, Any]]) -> str:
    existing_count = sum(1 for pane in panes if pane.get("project_id") == project_id)
    fallback_name = project_id.replace("-", " ").title()
    base_name = get_project_display_name(project_id, fallback=fallback_name) or fallback_name
    return base_name if existing_count == 0 else f"{base_name} [{existing_count + 1}]"


def _session_recency_key(session: dict[str, Any]) -> tuple[datetime, datetime]:
    last_accessed = _parse_timestamp(session.get("last_accessed_at")) or datetime.min
    created_at = _parse_timestamp(session.get("created_at")) or datetime.min
    return (last_accessed, created_at)


def _normalize_working_dir(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return str(Path(value).expanduser().resolve())
    except OSError:
        return str(Path(value).expanduser())


def _find_matching_target(
    panes: list[dict[str, Any]],
    project_id: str,
    tool_slug: str,
    working_dir: str | None,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    requested_dir = _normalize_working_dir(working_dir)
    for pane in panes:
        if pane.get("pane_type") != "project" or pane.get("project_id") != project_id:
            continue
        for session in pane.get("sessions", []):
            if requested_dir is not None:
                session_dir = _normalize_working_dir(session.get("working_dir"))
                if session_dir != requested_dir:
                    continue
            if session.get("mode") == tool_slug and session.get("is_alive", True):
                candidates.append((pane, session))

    if not candidates:
        return None

    candidates.sort(key=lambda item: _session_recency_key(item[1]), reverse=True)
    return candidates[0]


def _build_target(
    pane: dict[str, Any],
    session: dict[str, Any],
    *,
    created: bool,
    started: bool,
) -> BrokerSessionTarget:
    session_id = str(session["id"])
    return BrokerSessionTarget(
        project_id=str(pane["project_id"]),
        mode=str(session["mode"]),
        pane_id=str(pane["id"]),
        pane_name=str(pane["pane_name"]),
        session_id=session_id,
        tmux_session_name=get_tmux_session_name(session_id),
        working_dir=session.get("working_dir"),
        created=created,
        started=started,
    )


def _find_reusable_target(
    project_id: str,
    tool_slug: str,
    panes: list[dict[str, Any]],
    working_dir: str | None,
) -> tuple[tuple[dict[str, Any], dict[str, Any]] | None, list[dict[str, Any]]]:
    attempted_session_ids: set[str] = set()
    current_panes = panes

    while True:
        match = _find_matching_target(current_panes, project_id, tool_slug, working_dir)
        if match is None:
            return None, current_panes

        pane, session = match
        session_id = str(session["id"])
        if session_id in attempted_session_ids:
            return None, current_panes
        attempted_session_ids.add(session_id)

        if lifecycle.ensure_session_alive(session_id):
            return (pane, session), current_panes

        current_panes = pane_store.list_panes_with_sessions(include_detached=True)


def ensure_project_tool_session(
    project_id: str,
    tool_slug: str,
    working_dir: str | None = None,
) -> BrokerSessionTarget:
    """Reuse or create the A-Term-managed project session for a tool."""
    panes = pane_store.list_panes_with_sessions(include_detached=True)
    match, panes = _find_reusable_target(project_id, tool_slug, panes, working_dir)

    if match is None:
        pane = pane_store.create_pane_with_sessions(
            pane_type="project",
            pane_name=_pane_name_for_project(project_id, panes),
            project_id=project_id,
            working_dir=working_dir,
            agent_tool_slug=tool_slug if tool_slug != "shell" else None,
        )
        session = next(
            (
                row for row in pane.get("sessions", [])
                if row.get("mode") == tool_slug
            ),
            None,
        )
        if session is None:
            raise ValueError(f"Created pane for {project_id} is missing mode '{tool_slug}'")
        created = True
    else:
        pane, session = match
        created = False
        if pane.get("active_mode") != tool_slug:
            pane_store.update_pane(str(pane["id"]), active_mode=tool_slug)

    project_settings_store.upsert_settings(project_id, enabled=True, active_mode=tool_slug)
    started = agent_service.ensure_agent_running_sync(str(session["id"])) if tool_slug != "shell" else False
    return _build_target(pane, session, created=created, started=started)


def list_project_tool_sessions(tool_slug: str | None = None) -> list[BrokerSessionTarget]:
    """List A-Term-managed project tool sessions that wrappers can attach to."""
    targets: list[BrokerSessionTarget] = []
    for pane in pane_store.list_panes_with_sessions(include_detached=True):
        if pane.get("pane_type") != "project" or not pane.get("project_id"):
            continue
        for session in pane.get("sessions", []):
            mode = str(session.get("mode") or "")
            if mode == "shell":
                continue
            if tool_slug is not None and mode != tool_slug:
                continue
            if not session.get("is_alive", True):
                continue
            target = _build_target(pane, session, created=False, started=False)
            if not tmux_session_exists_by_name(target.tmux_session_name):
                continue
            targets.append(target)

    targets.sort(key=lambda item: (item.project_id, item.mode, item.pane_name))
    return targets
