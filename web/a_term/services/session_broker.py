"""Session broker for the terminal launchers (``tsession``, ``tclaude``, ``tcodex``).

A launcher asks for "the <tool> session of <project>". The broker reuses the
most recently used Tether session for that project and tool, or creates one
through A-Term (``origin: a-term``, shown in a new A-Term pane), and returns
Tether's attach target for it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..branding import get_project_display_name
from ..storage import panes as pane_store
from ..storage import project_settings as project_settings_store
from ..tether import get_client
from . import agent_service, agent_tools, lifecycle, session_catalog

_REUSABLE_STATUSES = {"running", "pending", "uncertain"}


@dataclass(frozen=True)
class BrokerSessionTarget:
    """A Tether session a launcher can attach to."""

    project_id: str
    mode: str
    pane_id: str | None
    pane_name: str | None
    session_id: str
    tmux_session_name: str
    tmux_socket: str | None
    working_dir: str | None
    created: bool
    started: bool
    attach_argv: list[str] = field(default_factory=list)
    attach_env: dict[str, str] = field(default_factory=dict)


def _normalize_working_dir(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return str(Path(value).expanduser().resolve())
    except OSError:
        return str(Path(value).expanduser())


def _pane_name_for_project(project_id: str) -> str:
    existing = sum(1 for pane in pane_store.list_panes(include_detached=True) if pane.get("project_id") == project_id)
    fallback = project_id.replace("-", " ").title()
    base = get_project_display_name(project_id, fallback=fallback) or fallback
    return base if existing == 0 else f"{base} [{existing + 1}]"


def _recency(session: dict[str, Any]) -> tuple[int, str, str]:
    # Sessions A-Term shows first, then the most recently viewed, then newest.
    return (
        1 if session.get("pane_id") else 0,
        str(session.get("last_accessed_at") or ""),
        str(session.get("created_at") or ""),
    )


def _candidates(project_id: str, tool_slug: str, working_dir: str | None) -> list[dict[str, Any]]:
    requested_dir = _normalize_working_dir(working_dir)
    links = {link["session_id"]: link for link in pane_store.list_links()}
    found = []
    for descriptor in session_catalog.list_tether_sessions():
        session = session_catalog.from_tether(descriptor, links.get(str(descriptor.get("id"))))
        if session.get("project_id") != project_id or session.get("mode") != tool_slug:
            continue
        if session.get("status") not in _REUSABLE_STATUSES:
            continue
        if requested_dir is not None and _normalize_working_dir(session.get("working_dir")) != requested_dir:
            continue
        found.append(session)
    found.sort(key=_recency, reverse=True)
    return found


def _attach_details(session_id: str) -> tuple[list[str], dict[str, str]]:
    target = get_client().attach_target(session_id)
    argv = target.get("argv") if isinstance(target, dict) else None
    env = target.get("env") if isinstance(target, dict) else None
    return (
        [str(arg) for arg in argv] if isinstance(argv, list) else [],
        {str(k): str(v) for k, v in env.items()} if isinstance(env, dict) else {},
    )


def _build_target(session: dict[str, Any], *, created: bool, started: bool, with_attach: bool) -> BrokerSessionTarget:
    pane = pane_store.get_pane(str(session["pane_id"])) if session.get("pane_id") else None
    argv, env = _attach_details(str(session["id"])) if with_attach else ([], {})
    return BrokerSessionTarget(
        project_id=str(session.get("project_id") or ""),
        mode=str(session.get("mode") or ""),
        pane_id=str(pane["id"]) if pane else None,
        pane_name=str(pane["pane_name"]) if pane else None,
        session_id=str(session["id"]),
        tmux_session_name=str(session.get("tmux_session_name") or ""),
        tmux_socket=session.get("tmux_socket"),
        working_dir=session.get("working_dir"),
        created=created,
        started=started,
        attach_argv=argv,
        attach_env=env,
    )


def ensure_project_tool_session(
    project_id: str,
    tool_slug: str,
    working_dir: str | None = None,
) -> BrokerSessionTarget:
    """Reuse or create the project's session for ``tool_slug`` and return its attach target."""
    slug = agent_tools.canonical_slug(tool_slug)
    candidates = _candidates(project_id, slug, working_dir)
    created = False
    if candidates:
        session = candidates[0]
        if not session.get("pane_id"):
            # Show a reused session in A-Term too, without disturbing the layout.
            pane = pane_store.create_pane(
                pane_type="project",
                pane_name=_pane_name_for_project(project_id),
                project_id=project_id,
                active_mode=slug,
                is_detached=True,
            )
            pane_store.link_session(str(session["id"]), pane["id"], slug)
            session = {**session, "pane_id": pane["id"]}
    else:
        pane = lifecycle.create_pane_with_sessions(
            pane_type="project",
            pane_name=_pane_name_for_project(project_id),
            project_id=project_id,
            working_dir=working_dir,
            agent_tool_slug=slug if slug != agent_tools.SHELL_SLUG else None,
        )
        session = next((row for row in pane.get("sessions", []) if row.get("mode") == slug), None)
        if session is None:
            raise ValueError(f"Created pane for {project_id} is missing mode '{slug}'")
        created = True

    project_settings_store.upsert_settings(project_id, enabled=True, active_mode=slug)
    started = False
    if slug != agent_tools.SHELL_SLUG and not created and session.get("status") != "running":
        started = agent_service.start_agent(str(session["id"])).started
    refreshed = session_catalog.get_session(str(session["id"])) or session
    return _build_target(refreshed, created=created, started=started, with_attach=True)


def list_project_tool_sessions(tool_slug: str | None = None) -> list[BrokerSessionTarget]:
    """Running project agent sessions in Tether, whichever app created them."""
    slug = agent_tools.canonical_slug(tool_slug) if tool_slug else None
    links = {link["session_id"]: link for link in pane_store.list_links()}
    targets: list[BrokerSessionTarget] = []
    for descriptor in session_catalog.list_tether_sessions():
        session = session_catalog.from_tether(descriptor, links.get(str(descriptor.get("id"))))
        mode = str(session.get("mode") or "")
        if not session.get("project_id") or mode == agent_tools.SHELL_SLUG:
            continue
        if slug is not None and mode != slug:
            continue
        if session.get("status") not in _REUSABLE_STATUSES:
            continue
        targets.append(_build_target(session, created=False, started=False, with_attach=False))
    targets.sort(key=lambda item: (item.project_id, item.mode, item.session_id))
    return targets
