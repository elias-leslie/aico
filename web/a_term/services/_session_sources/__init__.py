"""The session catalog's internal seam: one adapter per kind of session.

Only :mod:`a_term.services.session_catalog` imports this package. Each
adapter answers the same port (:class:`SessionSource`) for its own kind:

- :mod:`.tether`: Tether sessions (8-hex ids), read and ended through Tether.
- :mod:`.legacy`: pre-Tether ``summitflow-<uuid>`` sessions on the default
  tmux server, attach-only until they end.
- :mod:`.own_tmux`: the user's own default-server sessions running an agent.

Respawn, load tool and rename are not on the port: only Tether can do them,
so :mod:`a_term.services.lifecycle` calls the Tether client for those.
"""

from __future__ import annotations

import functools
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol, cast

from ...constants import SHELL_MODE
from .. import session_capabilities
from ..session_capabilities import SessionFacts, SessionKind
from .tmux_panes import PaneRow

if TYPE_CHECKING:
    from ..session_catalog import Session

Link = dict[str, Any]
SessionList = list["Session"]


@dataclass(frozen=True)
class ListContext:
    """What one catalog call shares across adapters, built once per call.

    ``panes`` reads the default server's panes at most once per context, so a
    catalog call runs one ``list-panes -a`` however many adapters read it.
    """

    links: Mapping[str, Link]
    panes: Callable[[], list[PaneRow]]

    @classmethod
    def build(cls, links: Mapping[str, Link], read_panes: Callable[[], list[PaneRow]]) -> ListContext:
        return cls(links=links, panes=functools.cache(read_panes))


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


class SessionSource(Protocol):
    """The port every kind of session answers."""

    kind: SessionKind

    def owns(self, ref: str) -> bool:
        """Whether ``ref`` has this kind's id shape. The only place id shape is read."""
        ...

    def list(self, ctx: ListContext) -> SessionList:
        """Every live session of this kind. Never raises for an unreachable backend."""
        ...

    def get(self, ref: str, ctx: ListContext) -> Session | None:
        """One live session by id, or None when it is gone."""
        ...

    def attach_plan(self, ref: str, ctx: ListContext) -> AttachPlan:
        """The attach plan for ``ref``. Raises ``ValueError`` when it is gone or not attachable."""
        ...

    def end(self, ref: str) -> bool:
        """End the session; False when it was already gone. Pane links are the caller's."""
        ...

    def live_ids(self) -> set[str]:
        """Ids of every session of this kind still running (reconcile's liveness set)."""
        ...


def finish(row: dict[str, Any]) -> Session:
    """Add the capability flags to a builder's row. Raises ``KeyError`` on a partial row."""
    return cast("Session", {**row, **session_capabilities.flags(SessionFacts.of(row))})


def agent_state_for(mode: str, status: str | None) -> str:
    """Map Tether's lifecycle status onto A-Term's agent state badge."""
    if status == "pending":
        return "starting"
    if status == "uncertain":
        return "error"
    if mode == SHELL_MODE:
        return "not_started"
    return "running" if status in {"running", "legacy"} else "not_started"
