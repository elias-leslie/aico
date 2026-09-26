from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest

from a_term.services.session_close import SessionOwnerError, close_session


def _make_session(
    session_id: str,
    *,
    mode: str = "shell",
    pane_id: str | None = "pane-1",
) -> dict[str, object]:
    return {
        "id": session_id,
        "mode": mode,
        "pane_id": pane_id,
        "is_alive": True,
        "working_dir": "/workspace/project",
    }


def _make_pane(
    *,
    pane_id: str = "pane-1",
    active_mode: str = "codex",
    is_detached: bool = False,
    sessions: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "id": pane_id,
        "pane_type": "project",
        "project_id": "summitflow",
        "pane_name": "Summitflow",
        "active_mode": active_mode,
        "is_detached": is_detached,
        "sessions": sessions or [],
    }


def test_close_agent_session_also_removes_shell_companion_and_pane() -> None:
    """Closing an agent session when only shell companions remain deletes the whole pane."""
    session = _make_session("codex-1", mode="codex", pane_id="pane-1")
    shell = _make_session("shell-1", mode="shell", pane_id="pane-1")
    pane = _make_pane(active_mode="codex", sessions=[shell, session])

    with (
        patch("a_term.services.session_close.get_external_agent_tmux_session", return_value=None),
        patch("a_term.services.session_close.a_term_store.get_session", return_value=session),
        patch("a_term.services.session_close.pane_store.get_pane_with_sessions", return_value=pane),
        patch("a_term.services.session_close.delete_managed_session", return_value=True) as delete_mock,
        patch("a_term.services.session_close.pane_store.delete_pane") as delete_pane_mock,
    ):
        result = close_session("codex-1")

    assert result == {
        "deleted": True,
        "id": "codex-1",
        "next_session_id": None,
        "pane_id": "pane-1",
        "pane_deleted": True,
        "is_external": False,
    }
    delete_mock.assert_any_call("shell-1")
    delete_pane_mock.assert_called_once_with("pane-1")


def test_close_session_deletes_pane_when_last_session_removed() -> None:
    session = _make_session("shell-1", mode="shell", pane_id="pane-1")
    pane = _make_pane(active_mode="shell", sessions=[session])

    with (
        patch("a_term.services.session_close.get_external_agent_tmux_session", return_value=None),
        patch("a_term.services.session_close.a_term_store.get_session", return_value=session),
        patch("a_term.services.session_close.pane_store.get_pane_with_sessions", return_value=pane),
        patch("a_term.services.session_close.delete_managed_session", return_value=True),
        patch("a_term.services.session_close.pane_store.delete_pane", return_value=True) as delete_pane_mock,
    ):
        result = close_session("shell-1")

    assert result == {
        "deleted": True,
        "id": "shell-1",
        "next_session_id": None,
        "pane_id": "pane-1",
        "pane_deleted": True,
        "is_external": False,
    }
    delete_pane_mock.assert_called_once_with("pane-1")


def test_close_agent_session_cleans_up_detached_pane_too() -> None:
    """Closing agent in a detached pane still removes shell companion and pane."""
    session = _make_session("codex-1", mode="codex", pane_id="pane-1")
    shell = _make_session("shell-1", mode="shell", pane_id="pane-1")
    pane = _make_pane(active_mode="codex", is_detached=True, sessions=[shell, session])

    with (
        patch("a_term.services.session_close.get_external_agent_tmux_session", return_value=None),
        patch("a_term.services.session_close.a_term_store.get_session", return_value=session),
        patch("a_term.services.session_close.pane_store.get_pane_with_sessions", return_value=pane),
        patch("a_term.services.session_close.delete_managed_session", return_value=True) as delete_mock,
        patch("a_term.services.session_close.pane_store.delete_pane") as delete_pane_mock,
    ):
        result = close_session("codex-1")

    assert result["pane_deleted"] is True
    assert result["next_session_id"] is None
    delete_mock.assert_any_call("shell-1")
    delete_pane_mock.assert_called_once_with("pane-1")


def test_close_shell_session_keeps_pane_with_agent() -> None:
    """Closing the shell session preserves the pane when an agent session remains."""
    shell = _make_session("shell-1", mode="shell", pane_id="pane-1")
    agent = _make_session("codex-1", mode="codex", pane_id="pane-1")
    pane = _make_pane(active_mode="shell", sessions=[shell, agent])

    with (
        patch("a_term.services.session_close.get_external_agent_tmux_session", return_value=None),
        patch("a_term.services.session_close.a_term_store.get_session", return_value=shell),
        patch("a_term.services.session_close.pane_store.get_pane_with_sessions", return_value=pane),
        patch("a_term.services.session_close.delete_managed_session", return_value=True),
        patch("a_term.services.session_close.pane_store.update_pane") as update_pane_mock,
        patch("a_term.services.session_close.pane_store.delete_pane") as delete_pane_mock,
    ):
        result = close_session("shell-1")

    assert result["pane_deleted"] is False
    assert result["next_session_id"] == "codex-1"
    update_pane_mock.assert_called_once_with("pane-1", active_mode="codex")
    delete_pane_mock.assert_not_called()


def test_close_aico_session_delegates_to_verified_owner() -> None:
    external = {
        "id": "tmux:aico-abcd1234:aico-deadbeef",
        "tmux_session_name": "aico-deadbeef",
        "tmux_session_id": "$4",
        "tmux_pane_id": "%8",
        "tmux_source": "aico-abcd1234",
    }
    requests: list[httpx.Request] = []

    def owner_response(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={
                "owner": "aico", "widgetId": "deadbeef", "sessionId": "aico-widget-deadbeef",
                "generation": "generation-1", "tmuxSessionId": "$4", "paneId": "%8",
            })
        return httpx.Response(200, json={"status": "ended"})

    with (
        patch("a_term.services.session_close.get_external_agent_tmux_session", return_value=external),
        patch("a_term.services.session_close.httpx.HTTPTransport", return_value=httpx.MockTransport(owner_response)),
    ):
        result = close_session(external["id"])

    assert result == {
        "deleted": True,
        "id": external["id"],
        "next_session_id": None,
        "pane_id": None,
        "pane_deleted": False,
        "is_external": True,
    }
    assert [request.method for request in requests] == ["GET", "POST"]
    assert requests[1].content == b'{"generation":"generation-1"}'


def test_close_aico_session_preserves_session_on_stale_generation() -> None:
    external = {
        "tmux_session_name": "aico-deadbeef", "tmux_session_id": "$4",
        "tmux_pane_id": "%8", "tmux_source": "aico-abcd1234",
    }
    requests: list[httpx.Request] = []

    def stale_response(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={
            "owner": "aico", "widgetId": "deadbeef", "generation": "stale",
            "tmuxSessionId": "$5", "paneId": "%8",
        })

    with (
        patch("a_term.services.session_close.get_external_agent_tmux_session", return_value=external),
        patch("a_term.services.session_close.httpx.HTTPTransport", return_value=httpx.MockTransport(stale_response)),
        pytest.raises(SessionOwnerError) as error,
    ):
        close_session("external")

    assert error.value.status_code == 409
    assert [request.method for request in requests] == ["GET"]


def test_close_unknown_external_owner_fails_closed() -> None:
    with (
        patch("a_term.services.session_close.get_external_agent_tmux_session", return_value={
            "tmux_session_name": "codex-historical", "tmux_source": "default",
        }),
        pytest.raises(SessionOwnerError) as error,
    ):
        close_session("codex-historical")

    assert error.value.status_code == 409


def test_close_aico_session_reports_unconfirmed_end_without_success() -> None:
    external = {
        "tmux_session_name": "aico-deadbeef", "tmux_session_id": "$4",
        "tmux_pane_id": "%8", "tmux_source": "aico-abcd1234",
    }

    def failed_post(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            raise httpx.ConnectError("owner disconnected", request=request)
        return httpx.Response(200, json={
            "owner": "aico", "widgetId": "deadbeef", "generation": "generation-1",
            "tmuxSessionId": "$4", "paneId": "%8",
        })

    with (
        patch("a_term.services.session_close.get_external_agent_tmux_session", return_value=external),
        patch("a_term.services.session_close.httpx.HTTPTransport", return_value=httpx.MockTransport(failed_post)),
        pytest.raises(SessionOwnerError) as error,
    ):
        close_session("external")

    assert error.value.status_code == 503
    assert "did not confirm" in error.value.detail
