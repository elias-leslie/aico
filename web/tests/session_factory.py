"""Catalog sessions for tests, built through the real builders (never by hand).

A hand-written session dict drifts from what the catalog returns; these go
through ``from_tether``, ``from_legacy`` and Own tmux discovery, so every key
and capability flag is the catalog's own.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

from a_term.services import session_catalog
from a_term.services.session_catalog import Session

TETHER_ID = "a1b2c3d4"
LEGACY_ID = "70b339cd-93a0-4898-8c4b-3d694ce8e8dc"


def tether_descriptor(**fields: Any) -> dict[str, Any]:
    """A Tether descriptor; ``fields`` override the defaults (e.g. ``rootRequestId``)."""
    return {
        "id": TETHER_ID,
        "label": "Session 1",
        "tool": "codex",
        "status": "running",
        "origin": "a-term",
        "projectId": "proj",
        "projectRoot": "/srv/proj",
        "generation": "g" * 64,
        "tmux": {"sessionName": f"tether-{TETHER_ID}", "sessionId": "$1", "paneId": "%1", "socket": "/tmp/t.sock"},
        **fields,
    }


def tether(*, link: dict[str, Any] | None = None, **fields: Any) -> Session:
    return session_catalog.from_tether(tether_descriptor(**fields), link)


def legacy_row(command: str = "codex") -> dict[str, str]:
    return {
        "session_name": f"summitflow-{LEGACY_ID}",
        "session_id": "$2",
        "pane_id": "%2",
        "working_dir": "/srv/old",
        "command": command,
        "pane_pid": "999999999",
    }


def legacy(*, command: str = "codex", link: dict[str, Any] | None = None) -> Session:
    """A Legacy session. Unlinked, its mode comes from ``command``; linked, from the link."""
    return session_catalog.from_legacy(LEGACY_ID, legacy_row(command), link)


def own_tmux_panes(name: str = "claude-work", command: str = "claude") -> str:
    """One ``list-panes -a`` line for an Own tmux session (no working dir: no git probe)."""
    return f"{name}\t$3\t%3\t\t{command}\t999999998"


def own_tmux(name: str = "claude-work", command: str = "claude") -> Session:
    """An Own tmux session, discovered from a faked default tmux server."""
    with patch("a_term.utils.tmux.run_tmux_command", return_value=(True, own_tmux_panes(name, command))):
        session = session_catalog.get_session(name)
    assert session is not None
    return session
