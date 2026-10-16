"""The sessions A-Term shows, in A-Term's API shape.

Three kinds of session reach A-Term:

- **Tether sessions** (8-hex ids): every session Tether owns, whichever app
  created it. Aico-created sessions are listed and attached natively.
- **Legacy sessions** (UUID ids): pre-Tether A-Term sessions still running as
  ``summitflow-<uuid>`` on the user's default tmux server. Attach-only until
  they end.
- **Own tmux sessions** (tmux session name ids): the user's own default-server
  sessions running an agent. A-Term shows them but never renames, respawns or
  ends them. The wire keeps ``source: "tmux_external"``.

Every builder writes every :class:`Session` key, then :func:`_finish` adds the
capability flags (``can_rename``, ``can_respawn``, ``can_end``) from
:mod:`session_capabilities`, so callers read a flag instead of re-deriving a
rule. A session that no A-Term pane shows is ``is_external`` (the frontend
attaches it as a free-standing view). Pane links live in local view state.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any, TypedDict, cast

from ..constants import AgentState
from ..logging_config import get_logger
from ..storage import panes as pane_store
from ..tether import TetherError, TetherUnavailable, get_client
from ..utils import tmux
from . import session_capabilities
from .session_capabilities import SessionFacts, SessionKind

logger = get_logger(__name__)


class Session(TypedDict):
    """One session in A-Term's shape. Total: every builder writes every key."""

    id: str
    source: SessionKind
    name: str
    mode: str
    status: str | None
    project_id: str | None
    working_dir: str | None
    user_id: None
    display_order: int
    session_number: int
    is_alive: bool
    created_at: str | None
    last_accessed_at: str | None
    agent_state: AgentState
    tmux_session_name: str | None
    tmux_session_id: str | None
    tmux_pane_id: str | None
    tmux_socket: str | None
    tmux_source: str
    tmux_source_label: str
    is_external: bool  # a View fact: no A-Term pane shows it (link is None)
    is_root: bool
    is_legacy: bool
    origin: str | None
    generation: str | None
    pane_id: str | None
    activity: str
    activity_previous: str
    activity_at: int | None
    activity_detail: str | None
    task: str | None
    badge: dict[str, str] | None
    is_coordinator: bool
    coordinator_id: str | None
    can_rename: bool
    can_respawn: bool
    can_end: bool


def _finish(row: dict[str, Any]) -> Session:
    """Add the capability flags to a builder's row. Raises ``KeyError`` on a partial row."""
    return cast("Session", {**row, **session_capabilities.flags(SessionFacts.of(row))})

SHELL_MODE = "shell"
TETHER_ID = re.compile(r"^[0-9a-f]{8}$")
LEGACY_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TMUX_SESSION_ID = re.compile(r"^\$[0-9]+$")
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


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


ACTIVITY_STATES = frozenset({"working", "idle", "blocked", "unknown"})


def _activity(value: Any) -> str:
    return value if isinstance(value, str) and value in ACTIVITY_STATES else "unknown"


# Aico's Personal Workspace (aico electron/main/project.ts personalWorkspaceRoot).
def _task(descriptor: dict[str, Any]) -> str | None:
    """Tether's ``name`` (the task title): the rename value."""
    name = descriptor.get("name")
    return name.strip() or None if isinstance(name, str) else None


def _badge(descriptor: dict[str, Any]) -> dict[str, str] | None:
    """Tether's ``badge`` as it is, or None when it is missing or not well formed."""
    badge = descriptor.get("badge")
    if not isinstance(badge, dict):
        return None
    kind, text, color = badge.get("kind"), badge.get("text"), badge.get("color")
    if kind not in ("coordinator", "child") or not isinstance(text, str) or not text.strip():
        return None
    if not isinstance(color, str) or not HEX_COLOR.match(color):
        return None
    return {"kind": kind, "text": text, "color": color}


def from_tether(descriptor: dict[str, Any], link: dict[str, Any] | None = None) -> Session:
    """Tether session descriptor -> A-Term session dict.

    The title (``displayTitle``) and the badge come worded from Tether
    (tether docs/api-v1.md "Display title and badge"); A-Term shows them as
    they are.
    """
    coordinator_id = descriptor.get("coordinatorId")
    title = descriptor.get("displayTitle")
    raw_tmux = descriptor.get("tmux")
    tmux_info: dict[str, Any] = raw_tmux if isinstance(raw_tmux, dict) else {}
    mode = str(descriptor.get("tool") or SHELL_MODE)
    status = descriptor.get("status")
    agent_state = agent_state_for(mode, status if isinstance(status, str) else None)
    return _finish({
        "id": descriptor["id"],
        "name": title.strip() if isinstance(title, str) and title.strip() else str(descriptor.get("label") or descriptor["id"]),
        "task": _task(descriptor),
        "badge": _badge(descriptor),
        "is_coordinator": descriptor.get("coordinator") is True,
        "coordinator_id": coordinator_id if isinstance(coordinator_id, str) else None,
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
        "generation": descriptor.get("generation"),
        "pane_id": (link or {}).get("pane_id"),
        # Tether's agent state (tether docs/agent-state.md), read as-is: the
        # session list groups by it (needs you, finished, working, idle).
        "activity": _activity(descriptor.get("state")),
        "activity_previous": _activity(descriptor.get("statePrevious")),
        "activity_at": descriptor.get("stateAt") if isinstance(descriptor.get("stateAt"), int) else None,
        "activity_detail": descriptor.get("stateDetail") if isinstance(descriptor.get("stateDetail"), str) else None,
    })


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


def from_legacy(session_uuid: str, row: dict[str, str], link: dict[str, Any] | None) -> Session:
    if link is not None:
        mode = str(link.get("mode") or SHELL_MODE)
    else:
        mode, _ = tmux._infer_external_mode(row["session_name"], row["command"], row["pane_pid"])
    pane = pane_store.get_pane(link["pane_id"]) if link else None
    agent_state = agent_state_for(mode, "legacy")
    return _finish({
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
        "generation": None,
        "pane_id": (link or {}).get("pane_id"),
        "activity": "unknown",
        "activity_previous": "unknown",
        "activity_at": None,
        "activity_detail": None,
        "task": None,
        "badge": None,
        "is_coordinator": False,
        "coordinator_id": None,
    })


def _number_sessions(sessions: list[Session]) -> None:
    counters: dict[tuple[Any, str], int] = {}
    for session in sorted(sessions, key=lambda item: str(item.get("created_at") or "")):
        key = (session.get("project_id"), str(session.get("mode")))
        counters[key] = counters.get(key, 0) + 1
        session["session_number"] = counters[key]


def list_tether_sessions() -> list[dict[str, Any]]:
    """Raw Tether descriptors. Raises :class:`TetherUnavailable` when Tether is down."""
    return get_client().list_sessions()


def list_sessions(*, include_external: bool = True) -> list[Session]:
    """Every session A-Term can show. Tether being down hides only Tether sessions.

    ``include_external`` adds the user's Own tmux sessions.
    """
    links = {link["session_id"]: link for link in pane_store.list_links()}
    sessions: list[Session] = []
    try:
        descriptors = [d for d in list_tether_sessions() if isinstance(d.get("id"), str)]
        for descriptor in descriptors:
            sessions.append(from_tether(descriptor, links.get(descriptor["id"])))
    except (TetherUnavailable, TetherError) as error:
        logger.warning("tether_sessions_unavailable", error=str(error))
    for session_uuid, row in _legacy_rows().items():
        sessions.append(from_legacy(session_uuid, row, links.get(session_uuid)))
    _number_sessions(sessions)
    if include_external:
        sessions.extend(_finish(dict(row)) for row in tmux.list_external_tmux_sessions())
    sessions.sort(key=lambda item: (int(item.get("display_order") or 0), str(item.get("created_at") or "")))
    return sessions


def get_session(session_ref: str) -> Session | None:
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
    return _finish(dict(external)) if external else None


def sessions_by_id() -> dict[str, Session]:
    return {str(session["id"]): session for session in list_sessions(include_external=False)}


def pane_with_sessions(pane: dict[str, Any], known: dict[str, Session]) -> dict[str, Any]:
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
