"""Tests for canonical A-Term note scope normalization."""

from a_term.storage.notes_helpers import normalize_project_scope


def test_normalize_project_scope_maps_terminal_alias() -> None:
    assert normalize_project_scope("terminal") == "a-term"


def test_normalize_project_scope_keeps_canonical_values() -> None:
    assert normalize_project_scope("a-term") == "a-term"
    assert normalize_project_scope("agent-hub") == "agent-hub"


def test_normalize_project_scope_defaults_blank_to_global() -> None:
    assert normalize_project_scope("") == "global"
    assert normalize_project_scope(None) == "global"
