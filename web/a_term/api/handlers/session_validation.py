"""Resolve a session into an attach plan for a WebSocket view.

Tether sessions attach with the exact argv Tether hands out
(``tmux -S <socket> attach-session -t <target>``) and every later tmux call
for the view uses that socket. Legacy and the user's own sessions attach on
the default tmux server.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any

from ...logging_config import get_logger
from ...services import session_catalog
from ...storage import panes as pane_store
from ...tether import TetherError, TetherUnavailable, get_client
from ...utils.tmux import build_tmux_command, validate_session_name, validate_socket_name

logger = get_logger(__name__)

_TMUX_SESSION_ID = re.compile(r"^\$[0-9]+$")


@dataclass
class AttachPlan:
    """Everything a WebSocket view needs to attach to and observe one session."""

    session: dict[str, Any]
    kind: str  # "tether" | "legacy" | "external"
    tmux_session_name: str
    tmux_socket: str | None
    argv: list[str]
    env: dict[str, str] = field(default_factory=dict)
    unset: list[str] = field(default_factory=list)
    generation: str | None = None

    @property
    def session_id(self) -> str:
        return str(self.session["id"])


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
        or not (_TMUX_SESSION_ID.fullmatch(argv[5]) or validate_session_name(argv[5]))
    ):
        raise ValueError("Tether returned an unexpected attach target")
    return [str(arg) for arg in argv]


def _tether_plan(session_id: str) -> AttachPlan:
    client = get_client()
    try:
        descriptor = client.get_session(session_id)
        target = client.attach_target(session_id)
    except TetherError as error:
        if error.status == 404:
            raise ValueError(f"Session not found: {session_id}") from error
        raise ValueError(f"Session cannot be attached ({error.code}): {session_id}") from error
    except TetherUnavailable as error:
        raise ValueError("Tether is not reachable; try again shortly") from error
    session = session_catalog.from_tether(descriptor, pane_store.get_link(session_id))
    socket_path = session.get("tmux_socket")
    session_name = session.get("tmux_session_name")
    if not isinstance(socket_path, str) or not isinstance(session_name, str) or not validate_session_name(session_name):
        raise ValueError(f"Session has no attachable tmux target: {session_id}")
    argv = _validated_tether_argv(target, socket_path)
    raw_env = target.get("env")
    env = (
        {str(key): value for key, value in raw_env.items() if isinstance(value, str)} if isinstance(raw_env, dict) else {}
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


def validate_and_prepare_session(session_id: str) -> AttachPlan:
    """Resolve ``session_id`` to an attach plan.

    Raises ``ValueError`` when the session is gone or cannot be attached. A
    dead session is reported, never re-created.
    """
    if session_catalog.is_tether_id(session_id):
        plan = _tether_plan(session_id)
        pane_store.touch_link(session_id)
        return plan

    session = session_catalog.get_session(session_id)
    if session is None:
        logger.warning("a_term_session_dead", session_id=session_id)
        raise ValueError(f"Session not found: {session_id}")
    session_name = str(session.get("tmux_session_name") or "")
    if not validate_session_name(session_name):
        raise ValueError(f"Invalid tmux session name for {session_id}")
    if session.get("source") == "legacy":
        pane_store.touch_link(session_id)
    return AttachPlan(
        session=session,
        kind="legacy" if session.get("source") == "legacy" else "external",
        tmux_session_name=session_name,
        tmux_socket=None,
        argv=build_tmux_command(["attach-session", "-t", session_name]),
    )
