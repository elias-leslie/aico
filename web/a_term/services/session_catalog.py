"""The sessions A-Term shows, in A-Term's API shape.

Three kinds of session reach A-Term:

- **Tether sessions** (8-hex ids): every session Tether owns, whichever app
  created it. Aico-created sessions are listed and attached natively.
- **Legacy sessions** (UUID ids): pre-Tether A-Term sessions still running as
  ``summitflow-<uuid>`` on the user's default tmux server. Attach-only until
  they end.
- **External sessions** (tmux session name ids): the user's own default-server
  sessions running an agent.

A session that no A-Term pane shows is ``is_external`` (the frontend attaches
it as a free-standing view). Pane links live in local view state.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from ..logging_config import get_logger
from ..storage import panes as pane_store
from ..tether import TetherError, TetherUnavailable, get_client
from ..utils import tmux

logger = get_logger(__name__)

SHELL_MODE = "shell"
TETHER_ID = re.compile(r"^[0-9a-f]{8}$")
LEGACY_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TMUX_SESSION_ID = re.compile(r"^\$[0-9]+$")


def is_tether_id(session_id: str) -> bool:
    return bool(TETHER_ID.fullmatch(session_id))


def is_legacy_id(session_id: str) -> bool:
    return bool(LEGACY_ID.fullmatch(session_id))


def _iso(value: Any) -> str | None:
    if isinstance(value, int | float) and value > 0:
        return datetime.fromtimestamp(value / 1000, tz=UTC).isoformat()
    return value if isinstance(value, str) else None


def agent_state_for(mode: str, status: str | None) -> str:
    """Map Tether's lifecycle status onto A-Term's agent state badge."""
    if status == "pending":
        return "starting"
    if status == "uncertain":
        return "error"
    if mode == SHELL_MODE:
        return "not_started"
    return "running" if status in {"running", "legacy"} else "not_started"


def from_tether(descriptor: dict[str, Any], link: dict[str, Any] | None = None) -> dict[str, Any]:
    """Tether session descriptor -> A-Term session dict."""
    raw_tmux = descriptor.get("tmux")
    tmux_info: dict[str, Any] = raw_tmux if isinstance(raw_tmux, dict) else {}
    mode = str(descriptor.get("tool") or SHELL_MODE)
    status = descriptor.get("status")
    agent_state = agent_state_for(mode, status if isinstance(status, str) else None)
    return {
        "id": descriptor["id"],
        "name": descriptor.get("name") or descriptor.get("label") or descriptor["id"],
        "user_id": None,
        "project_id": descriptor.get("projectId"),
        "working_dir": descriptor.get("projectRoot"),
        "display_order": int((link or {}).get("display_order") or 0),
        "mode": mode,
        "session_number": 1,
        "is_alive": True,
        "created_at": _iso(descriptor.get("createdAt")),
        "last_accessed_at": (link or {}).get("last_accessed_at"),
        "agent_state": agent_state,
        "claude_state": agent_state,
        "tmux_session_name": tmux_info.get("sessionName"),
        "tmux_session_id": tmux_info.get("sessionId"),
        "tmux_pane_id": tmux_info.get("paneId"),
        "tmux_socket": tmux_info.get("socket"),
        "tmux_source": "tether",
        "tmux_source_label": "Tether",
        "is_external": link is None,
        "is_root": bool(descriptor.get("rootRequestId")),
        "is_legacy": status == "legacy",
        "source": "tether",
        "origin": descriptor.get("origin"),
        "status": status,
        "available": bool(descriptor.get("available")),
        "generation": descriptor.get("generation"),
        "pane_id": (link or {}).get("pane_id"),
        "root_request_id": descriptor.get("rootRequestId"),
    }


def _legacy_rows() -> dict[str, dict[str, str]]:
    """Live ``summitflow-<uuid>`` panes on the default server, keyed by UUID."""
    success, output = tmux.run_tmux_command(
        [
            "list-panes",
            "-a",
            "-F",
            "#{session_name}\t#{session_id}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}",
        ]
    )
    if not success:
        return {}
    rows: dict[str, dict[str, str]] = {}
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) != 6 or not tmux.is_managed_tmux_session_name(parts[0]):
            continue
        session_uuid = parts[0][len(tmux.TMUX_SESSION_PREFIX) :]
        rows.setdefault(
            session_uuid,
            {
                "session_name": parts[0],
                "session_id": parts[1],
                "pane_id": parts[2],
                "working_dir": parts[3],
                "command": parts[4],
                "pane_pid": parts[5],
            },
        )
    return rows


def from_legacy(session_uuid: str, row: dict[str, str], link: dict[str, Any] | None) -> dict[str, Any]:
    if link is not None:
        mode = str(link.get("mode") or SHELL_MODE)
    else:
        mode, _ = tmux._infer_external_mode(row["session_name"], row["command"], row["pane_pid"])
    pane = pane_store.get_pane(link["pane_id"]) if link else None
    agent_state = agent_state_for(mode, "legacy")
    return {
        "id": session_uuid,
        "name": (pane or {}).get("pane_name") or row["session_name"],
        "user_id": None,
        "project_id": (pane or {}).get("project_id"),
        "working_dir": row.get("working_dir") or None,
        "display_order": int((link or {}).get("display_order") or 0),
        "mode": mode,
        "session_number": 1,
        "is_alive": True,
        "created_at": (link or {}).get("created_at"),
        "last_accessed_at": (link or {}).get("last_accessed_at"),
        "agent_state": agent_state,
        "claude_state": agent_state,
        "tmux_session_name": row["session_name"],
        "tmux_session_id": row["session_id"] or None,
        "tmux_pane_id": row["pane_id"] or None,
        "tmux_socket": None,
        "tmux_source": "legacy",
        "tmux_source_label": "A-Term (legacy)",
        "is_external": link is None,
        "is_root": False,
        "is_legacy": True,
        "source": "legacy",
        "origin": "a-term",
        "status": "legacy",
        "available": True,
        "generation": None,
        "pane_id": (link or {}).get("pane_id"),
        "root_request_id": None,
    }


def _number_sessions(sessions: list[dict[str, Any]]) -> None:
    counters: dict[tuple[Any, str], int] = {}
    for session in sorted(sessions, key=lambda item: str(item.get("created_at") or "")):
        key = (session.get("project_id"), str(session.get("mode")))
        counters[key] = counters.get(key, 0) + 1
        session["session_number"] = counters[key]


def list_tether_sessions() -> list[dict[str, Any]]:
    """Raw Tether descriptors. Raises :class:`TetherUnavailable` when Tether is down."""
    return get_client().list_sessions()


def list_sessions(*, include_external: bool = True) -> list[dict[str, Any]]:
    """Every session A-Term can show. Tether being down hides only Tether sessions."""
    links = {link["session_id"]: link for link in pane_store.list_links()}
    sessions: list[dict[str, Any]] = []
    try:
        for descriptor in list_tether_sessions():
            if isinstance(descriptor.get("id"), str):
                sessions.append(from_tether(descriptor, links.get(descriptor["id"])))
    except (TetherUnavailable, TetherError) as error:
        logger.warning("tether_sessions_unavailable", error=str(error))
    for session_uuid, row in _legacy_rows().items():
        sessions.append(from_legacy(session_uuid, row, links.get(session_uuid)))
    _number_sessions(sessions)
    if include_external:
        sessions.extend(tmux.list_external_tmux_sessions())
    sessions.sort(key=lambda item: (int(item.get("display_order") or 0), str(item.get("created_at") or "")))
    return sessions


def get_session(session_ref: str) -> dict[str, Any] | None:
    """One session by A-Term id. Tether sessions are live-verified by Tether."""
    if is_tether_id(session_ref):
        try:
            descriptor = get_client().get_session(session_ref)
        except TetherError as error:
            if error.status == 404:
                return None
            raise
        return from_tether(descriptor, pane_store.get_link(session_ref))
    if is_legacy_id(session_ref):
        row = _legacy_rows().get(session_ref)
        return from_legacy(session_ref, row, pane_store.get_link(session_ref)) if row else None
    external = tmux.get_external_agent_tmux_session(session_ref)
    return dict(external) if external else None


def sessions_by_id() -> dict[str, dict[str, Any]]:
    return {str(session["id"]): session for session in list_sessions(include_external=False)}


def pane_with_sessions(pane: dict[str, Any], known: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Attach the live sessions a pane shows (dead links are skipped, not deleted)."""
    sessions = []
    for link in pane_store.links_for_pane(pane["id"]):
        session = known.get(link["session_id"])
        if session is not None:
            sessions.append(session)
    sessions.sort(key=lambda session: str(session.get("mode")))
    return {**pane, "sessions": sessions}


def list_panes_with_sessions(include_detached: bool = False) -> list[dict[str, Any]]:
    known = sessions_by_id()
    return [pane_with_sessions(pane, known) for pane in pane_store.list_panes(include_detached=include_detached)]


def get_pane_with_sessions(pane_id: str) -> dict[str, Any] | None:
    pane = pane_store.get_pane(pane_id)
    if pane is None:
        return None
    return pane_with_sessions(pane, sessions_by_id())
