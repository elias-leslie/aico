"""Tether sessions (8-hex ids): every session Tether owns, whichever app created it.

Listed, attached and ended through Tether. Tether sessions attach with the
exact argv Tether hands out (``tmux -S <socket> attach-session -t <target>``),
and every later tmux call for the view uses that socket.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from ...constants import SHELL_MODE
from ...logging_config import get_logger
from ...tether import TetherClient, TetherError, TetherUnavailable, get_client
from ...utils.tmux import validate_session_name, validate_socket_name
from ..session_capabilities import LifecycleError, SessionKind
from . import AttachPlan, Link, ListContext, SessionList, agent_state_for, finish

if TYPE_CHECKING:
    from ..session_catalog import Session

logger = get_logger(__name__)

TETHER_ID = re.compile(r"^[0-9a-f]{8}$")
TMUX_SESSION_ID = re.compile(r"^\$[0-9]+$")
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
ACTIVITY_STATES = frozenset({"working", "idle", "blocked", "unknown"})


def _iso(value: Any) -> str | None:
    if isinstance(value, int | float) and value > 0:
        return datetime.fromtimestamp(value / 1000, tz=UTC).isoformat()
    return value if isinstance(value, str) else None


def _activity(value: Any) -> str:
    return value if isinstance(value, str) and value in ACTIVITY_STATES else "unknown"


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


def from_tether(descriptor: dict[str, Any], link: Link | None = None) -> Session:
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
    return finish({
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


def _validated_tether_argv(target: dict[str, Any], socket_path: str) -> list[str]:
    """Accept only ``<abs>/tmux -S <socket> attach-session -t <target>`` from Tether."""
    argv = target.get("argv")
    if (
        not isinstance(argv, list)
        or len(argv) != 6
        or not all(isinstance(arg, str) for arg in argv)
        or not os.path.isabs(argv[0])
        or os.path.basename(argv[0]) != "tmux"
        or argv[1] != "-S"
        or argv[2] != socket_path
        or not validate_socket_name(argv[2])
        or argv[3] not in {"attach-session", "attach"}
        or argv[4] != "-t"
        or not (TMUX_SESSION_ID.fullmatch(argv[5]) or validate_session_name(argv[5]))
    ):
        raise ValueError("Tether returned an unexpected attach target")
    return [str(arg) for arg in argv]


class TetherSource:
    """Tether's catalog, through the Tether client."""

    kind: SessionKind = "tether"

    def __init__(self, client_factory: Callable[[], TetherClient] = get_client) -> None:
        self._client = client_factory

    def owns(self, ref: str) -> bool:
        return bool(TETHER_ID.fullmatch(ref))

    def list(self, ctx: ListContext) -> SessionList:
        """Every Tether session. Tether being down or refusing hides only Tether sessions."""
        try:
            descriptors = [d for d in self._client().list_sessions() if isinstance(d.get("id"), str)]
        except (TetherUnavailable, TetherError) as error:
            logger.warning("tether_sessions_unavailable", error=str(error))
            return []
        return [from_tether(descriptor, ctx.links.get(descriptor["id"])) for descriptor in descriptors]

    def get(self, ref: str, ctx: ListContext) -> Session | None:
        """Live-verified by Tether. Raises :class:`TetherUnavailable` when Tether is down."""
        try:
            descriptor = self._client().get_session(ref)
        except TetherError as error:
            if error.status == 404:
                return None
            raise
        return from_tether(descriptor, ctx.links.get(ref))

    def attach_plan(self, ref: str, ctx: ListContext) -> AttachPlan:
        client = self._client()
        try:
            descriptor = client.get_session(ref)
            target = client.attach_target(ref)
        except TetherError as error:
            if error.status == 404:
                raise ValueError(f"Session not found: {ref}") from error
            raise ValueError(f"Session cannot be attached ({error.code}): {ref}") from error
        except TetherUnavailable as error:
            raise ValueError("Tether is not reachable; try again shortly") from error
        session = from_tether(descriptor, ctx.links.get(ref))
        socket_path = session.get("tmux_socket")
        session_name = session.get("tmux_session_name")
        if not isinstance(socket_path, str) or not isinstance(session_name, str) or not validate_session_name(session_name):
            raise ValueError(f"Session has no attachable tmux target: {ref}")
        argv = _validated_tether_argv(target, socket_path)
        raw_env = target.get("env")
        env = (
            {str(key): value for key, value in raw_env.items() if isinstance(value, str)}
            if isinstance(raw_env, dict)
            else {}
        )
        raw_unset = target.get("unset")
        unset = [key for key in raw_unset if isinstance(key, str)] if isinstance(raw_unset, list) else []
        return AttachPlan(
            session=session,
            kind="tether",
            tmux_session_name=session_name,
            tmux_socket=socket_path,
            argv=argv,
            env=env,
            unset=unset,
            generation=target.get("generation") if isinstance(target.get("generation"), str) else session.get("generation"),
        )

    def end(self, ref: str) -> bool:
        """Tether's End, fenced by the generation read just before it.

        A changed generation is reported (Tether's error), not retried. A
        session with no generation yet is refused with a 409.
        """
        client = self._client()
        try:
            descriptor = client.get_session(ref)
        except TetherError as error:
            if error.status == 404:
                return False
            raise
        generation = descriptor.get("generation")
        if not isinstance(generation, str):
            raise LifecycleError(409, "The session has no generation yet; refresh and try again")
        try:
            client.end_session(ref, generation)
        except TetherError as error:
            if error.status == 404:
                return False
            raise
        logger.info("session_ended", session_id=ref)
        return True

    def live_ids(self) -> set[str]:
        """Raises :class:`TetherUnavailable` when Tether is down: never "every session ended"."""
        return {str(item["id"]) for item in self._client().list_sessions() if item.get("id")}
