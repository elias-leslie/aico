"""Tests for the pane_mode control message.

The browser cannot tell who owns a pane's scrollback from its own xterm, so it
asks the session and the session asks tmux.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from a_term.api.handlers.websocket_messages import _handle_pane_mode_request


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(text)


@pytest.mark.asyncio
@patch("a_term.services.scrollback_pager.get_pane_mode", return_value=(True, True))
async def test_reports_a_program_that_owns_its_scrollback(_pane_mode):
    ws = FakeWebSocket()
    await _handle_pane_mode_request(ws, "aico-1", None)
    assert json.loads(ws.sent[0]) == {
        "__ctrl": True,
        "pane_mode": {"alternate_screen": True, "mouse_reporting": True},
    }


@pytest.mark.asyncio
@patch("a_term.services.scrollback_pager.get_pane_mode", return_value=(False, False))
async def test_reports_a_pane_whose_history_lives_in_tmux(_pane_mode):
    ws = FakeWebSocket()
    await _handle_pane_mode_request(ws, "aico-1", None)
    assert json.loads(ws.sent[0])["pane_mode"] == {
        "alternate_screen": False,
        "mouse_reporting": False,
    }


@pytest.mark.asyncio
@patch("a_term.services.scrollback_pager.get_pane_mode", return_value=None)
async def test_stays_quiet_when_tmux_cannot_answer(_pane_mode):
    ws = FakeWebSocket()
    await _handle_pane_mode_request(ws, "aico-1", None)
    assert ws.sent == []


@pytest.mark.asyncio
async def test_stays_quiet_without_a_tmux_session():
    ws = FakeWebSocket()
    await _handle_pane_mode_request(ws, None, None)
    assert ws.sent == []
