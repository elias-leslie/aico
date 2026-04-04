"""Tests for terminal session validation with external tmux sessions."""

from __future__ import annotations

from unittest.mock import patch

from terminal.api.handlers.session_validation import validate_and_prepare_session


def test_validate_and_prepare_session_accepts_external_tmux_session() -> None:
    external = {
        "id": "claude-summitflow",
        "tmux_session_name": "claude-summitflow",
        "working_dir": "/home/testuser/summitflow",
        "is_external": True,
    }
    with patch(
        "terminal.api.handlers.session_validation.get_external_agent_tmux_session",
        return_value=external,
    ):
        session, tmux_name = validate_and_prepare_session("claude-summitflow")

    assert session == external
    assert tmux_name == "claude-summitflow"


def test_validate_external_session_falls_back_to_session_id_when_tmux_name_missing() -> None:
    external = {
        "id": "claude-summitflow",
        "tmux_session_name": None,
        "working_dir": "/home/testuser/summitflow",
        "is_external": True,
    }
    with patch(
        "terminal.api.handlers.session_validation.get_external_agent_tmux_session",
        return_value=external,
    ):
        session, tmux_name = validate_and_prepare_session("claude-summitflow")

    assert session == external
    assert tmux_name == "claude-summitflow"  # Falls back to session_id
