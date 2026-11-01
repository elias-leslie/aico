"""Shared autouse fixtures for the st aico CLI tests."""

import pytest
from aico_cli_fixtures import admin


@pytest.fixture(autouse=True)
def no_launch_table(monkeypatch):
    """Agent Hub's launch table is unreadable unless a test serves a row: create never runs `st`."""
    monkeypatch.setattr(admin, "launch_row", lambda role, tool: None)
