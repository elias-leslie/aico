"""Legacy sessions (UUID ids): pre-Tether A-Term sessions still running.

They run as ``summitflow-<uuid>`` on the user's default tmux server and are
attach-only until they end. A-Term created them, so it may end them itself
with an exact ``kill-session``.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import TYPE_CHECKING

from ...constants import SHELL_MODE
from ...logging_config import get_logger
from ...storage import panes as pane_store
from ...utils import tmux
from ..session_capabilities import SessionKind
from . import AttachPlan, Link, ListContext, SessionList, agent_state_for, finish

if TYPE_CHECKING:
    from ..session_catalog import Session

logger = get_logger(__name__)

LEGACY_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# (session_name, current_command, pane_pid) -> (mode, agent_state)
InferMode = Callable[[str, str, str | None], tuple[str, str]]


def from_legacy(session_uuid: str, row: dict[str, str], link: Link | None, infer_mode: InferMode) -> Session:
    """A Legacy pane row -> A-Term session dict. Linked, the mode is the link's; unlinked, inferred."""
    if link is not None:
        mode = str(link.get("mode") or SHELL_MODE)
    else:
        mode, _ = infer_mode(row["session_name"], row["command"], row["pane_pid"])
    pane = pane_store.get_pane(link["pane_id"]) if link else None
    agent_state = agent_state_for(mode, "legacy")
    return finish({
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


class LegacySource:
    """Legacy sessions, read from the default server's panes."""

    kind: SessionKind = "legacy"

    def __init__(self, infer_mode: InferMode) -> None:
        self._infer_mode = infer_mode

    def owns(self, ref: str) -> bool:
        return bool(LEGACY_ID.fullmatch(ref))

    def build(self, session_uuid: str, row: dict[str, str], link: Link | None) -> Session:
        return from_legacy(session_uuid, row, link, self._infer_mode)

    def _rows(self, ctx: ListContext) -> dict[str, dict[str, str]]:
        """Live ``summitflow-<uuid>`` panes, keyed by UUID (the first pane of each session)."""
        rows: dict[str, dict[str, str]] = {}
        for pane in ctx.panes():
            if not tmux.is_managed_tmux_session_name(pane.session_name):
                continue
            rows.setdefault(
                pane.session_name[len(tmux.TMUX_SESSION_PREFIX) :],
                {
                    "session_name": pane.session_name,
                    "session_id": pane.session_id,
                    "pane_id": pane.pane_id,
                    "working_dir": pane.cwd,
                    "command": pane.command,
                    "pane_pid": pane.pid,
                },
            )
        return rows

    def list(self, ctx: ListContext) -> SessionList:
        return [self.build(session_uuid, row, ctx.links.get(session_uuid)) for session_uuid, row in self._rows(ctx).items()]

    def get(self, ref: str, ctx: ListContext) -> Session | None:
        row = self._rows(ctx).get(ref)
        return self.build(ref, row, ctx.links.get(ref)) if row else None

    def attach_plan(self, ref: str, ctx: ListContext) -> AttachPlan:
        session = self.get(ref, ctx)
        if session is None:
            logger.warning("a_term_session_dead", session_id=ref)
            raise ValueError(f"Session not found: {ref}")
        session_name = str(session.get("tmux_session_name") or "")
        if not tmux.validate_session_name(session_name):
            raise ValueError(f"Invalid tmux session name for {ref}")
        return AttachPlan(
            session=session,
            kind="legacy",
            tmux_session_name=session_name,
            tmux_socket=None,
            argv=tmux.build_tmux_command(["attach-session", "-t", session_name]),
        )

    def end(self, ref: str) -> bool:
        """An exact ``kill-session``; False when the session was already gone."""
        return tmux.kill_legacy_session(ref)

    def live_ids(self) -> set[str]:
        """UUIDs of the ``summitflow-<uuid>`` sessions on the default server (``list-sessions``)."""
        return tmux.list_tmux_sessions()
