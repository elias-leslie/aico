"""Tests for A-Term session lifecycle helpers."""

from __future__ import annotations

from unittest.mock import patch

from a_term.services import lifecycle


def test_create_session_reassigns_resurrected_session_to_requested_pane() -> None:
    """Resurrected project sessions keep the pane/session association current."""
    with (
        patch(
            "a_term.services.lifecycle.a_term_store.claim_dead_session_by_project",
            return_value={"id": "dead-session"},
        ) as claim_mock,
        patch("a_term.services.lifecycle.a_term_store.update_session") as update_mock,
        patch("a_term.services.lifecycle.create_tmux_session") as tmux_create_mock,
    ):
        session_id = lifecycle.create_session(
            name="Project: agent-hub",
            project_id="agent-hub",
            working_dir="/srv/workspaces/projects/agent-hub",
            mode="codex",
            pane_id="pane-new",
        )

    assert session_id == "dead-session"
    claim_mock.assert_called_once_with("agent-hub", "codex")
    update_mock.assert_called_once_with(
        "dead-session",
        name="Project: agent-hub",
        working_dir="/srv/workspaces/projects/agent-hub",
        is_alive=True,
        pane_id="pane-new",
    )
    tmux_create_mock.assert_called_once_with(
        "dead-session",
        "/srv/workspaces/projects/agent-hub",
    )
