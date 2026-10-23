"""The one session response model, shared by the Sessions and Panes APIs.

Its fields are exactly the session catalog's ``Session`` keys (a test pins
that), all required, so a builder that misses a key fails loudly instead of
falling back to a silent default. ``claude_state`` is a deprecated alias of
``agent_state``, computed so the two can never disagree.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, computed_field


class ATermSessionResponse(BaseModel):
    """A-Term session response model."""

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    user_id: str | None
    project_id: str | None
    working_dir: str | None
    display_order: int
    mode: str
    session_number: int
    is_alive: bool
    created_at: str | None
    last_accessed_at: str | None
    agent_state: str
    tmux_session_name: str | None
    tmux_session_id: str | None
    tmux_pane_id: str | None
    tmux_socket: str | None
    tmux_source: str
    tmux_source_label: str
    # A View fact: no A-Term pane shows the session. Informational, like
    # ``is_root``, ``is_legacy`` and ``source``: permissions are the ``can_*`` flags.
    is_external: bool
    is_root: bool
    is_legacy: bool  # a Tether session with status "legacy"
    source: str  # "tether" | "tmux_external" (an Own tmux session)
    origin: str | None
    status: str | None
    generation: str | None
    pane_id: str | None
    activity: str
    activity_previous: str
    activity_at: int | None
    activity_detail: str | None
    # ``name`` is Tether's displayTitle; ``task`` its raw name (the rename
    # value); ``badge`` {kind, text, color} as Tether words it.
    task: str | None
    badge: dict[str, str] | None
    is_coordinator: bool
    coordinator_id: str | None
    # What A-Term allows on this session (services/session_capabilities.py).
    can_rename: bool
    can_respawn: bool
    can_end: bool

    @computed_field
    @property
    def claude_state(self) -> str:
        """Deprecated compatibility alias of ``agent_state``."""
        return self.agent_state
