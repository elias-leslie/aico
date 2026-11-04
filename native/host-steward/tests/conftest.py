"""Shared autouse fixtures for the st aico CLI tests."""

import sys
from pathlib import Path

import pytest
from aico_cli_fixtures import admin

# host_steward (the check package) and aico_status sit one folder above the tests.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def no_launch_table(monkeypatch):
    """Agent Hub's launch table is unreadable unless a test serves a row: create never runs `st`."""
    monkeypatch.setattr(admin, "launch_row", lambda *_args: None)


@pytest.fixture(autouse=True)
def host_steward_state_in_tmp(monkeypatch, tmp_path):
    """No host-steward test writes beside the real state file (/var/lib/host-steward)."""
    from host_steward import core

    monkeypatch.setattr(core, "STATE_PATH", tmp_path / "host-steward" / "state.json")
