"""Tests for the shared A-Term session broker."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import call, patch

from a_term.services.session_broker import ensure_project_tool_session, list_project_tool_sessions


def _iso(ts: str) -> str:
    return datetime.fromisoformat(ts).astimezone(UTC).isoformat()


def _make_session(
    session_id: str,
    mode: str,
    *,
    working_dir: str = "/workspace/project",
    last_accessed_at: str | None = None,
) -> dict[str, object]:
    return {
        "id": session_id,
        "name": "Project: summitflow",
        "mode": mode,
        "session_number": 1,
        "is_alive": True,
        "working_dir": working_dir,
        "claude_state": "not_started",
        "last_accessed_at": _iso(last_accessed_at) if last_accessed_at else None,
        "created_at": _iso("2026-03-18T12:00:00+00:00"),
        "pane_id": "pane-1",
    }


def _make_pane(
    pane_id: str,
    project_id: str,
    active_mode: str,
    sessions: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "id": pane_id,
        "pane_type": "project",
        "project_id": project_id,
        "pane_order": 0,
        "pane_name": "Summitflow",
        "active_mode": active_mode,
        "created_at": datetime.now(UTC),
        "sessions": sessions,
        "width_percent": 100.0,
        "height_percent": 100.0,
        "grid_row": 0,
        "grid_col": 0,
    }


def test_ensure_project_tool_session_reuses_existing_matching_session() -> None:
    pane = _make_pane(
        "pane-1",
        "summitflow",
        "shell",
        [
            _make_session("shell-id", "shell", last_accessed_at="2026-03-18T12:00:00+00:00"),
            _make_session(
                "codex-id",
                "codex",
                working_dir="/workspace/summitflow",
                last_accessed_at="2026-03-18T13:00:00+00:00",
            ),
        ],
    )

    with (
        patch("a_term.services.session_broker.pane_store.list_panes_with_sessions", return_value=[pane]),
        patch("a_term.services.session_broker.lifecycle.ensure_session_alive", return_value=True),
        patch("a_term.services.session_broker.pane_store.update_pane") as update_pane_mock,
        patch("a_term.services.session_broker.project_settings_store.upsert_settings") as upsert_mock,
        patch("a_term.services.session_broker.agent_service.ensure_agent_running_sync", return_value=True) as start_mock,
    ):
        target = ensure_project_tool_session(
            project_id="summitflow",
            tool_slug="codex",
            working_dir="/workspace/summitflow",
        )

    assert target.session_id == "codex-id"
    assert target.pane_id == "pane-1"
    assert target.tmux_session_name == "summitflow-codex-id"
    assert target.created is False
    assert target.started is True
    update_pane_mock.assert_called_once_with("pane-1", active_mode="codex")
    upsert_mock.assert_called_once_with("summitflow", enabled=True, active_mode="codex")
    start_mock.assert_called_once_with("codex-id")


def test_ensure_project_tool_session_prefers_most_recent_matching_session() -> None:
    older = _make_pane(
        "pane-1",
        "summitflow",
        "codex",
        [
            _make_session("shell-old", "shell", last_accessed_at="2026-03-18T11:00:00+00:00"),
            _make_session(
                "codex-old",
                "codex",
                working_dir="/workspace/summitflow",
                last_accessed_at="2026-03-18T11:00:00+00:00",
            ),
        ],
    )
    newer = _make_pane(
        "pane-2",
        "summitflow",
        "codex",
        [
            _make_session("shell-new", "shell", last_accessed_at="2026-03-18T14:00:00+00:00"),
            _make_session(
                "codex-new",
                "codex",
                working_dir="/workspace/summitflow",
                last_accessed_at="2026-03-18T14:00:00+00:00",
            ),
        ],
    )

    with (
        patch(
            "a_term.services.session_broker.pane_store.list_panes_with_sessions",
            return_value=[older, newer],
        ),
        patch("a_term.services.session_broker.lifecycle.ensure_session_alive", return_value=True),
        patch("a_term.services.session_broker.pane_store.update_pane") as update_pane_mock,
        patch("a_term.services.session_broker.project_settings_store.upsert_settings"),
        patch("a_term.services.session_broker.agent_service.ensure_agent_running_sync", return_value=False),
    ):
        target = ensure_project_tool_session(
            project_id="summitflow",
            tool_slug="codex",
            working_dir="/workspace/summitflow",
        )

    assert target.session_id == "codex-new"
    update_pane_mock.assert_not_called()


def test_ensure_project_tool_session_creates_new_project_pane_when_missing() -> None:
    created_pane = _make_pane(
        "pane-3",
        "a-term",
        "claude",
        [
            _make_session("shell-3", "shell", working_dir="/workspace/a_term"),
            _make_session("claude-3", "claude", working_dir="/workspace/a_term"),
        ],
    )

    with (
        patch("a_term.services.session_broker.pane_store.list_panes_with_sessions", return_value=[]),
        patch("a_term.services.session_broker.lifecycle.ensure_session_alive", return_value=True),
        patch(
            "a_term.services.session_broker.pane_store.create_pane_with_sessions",
            return_value=created_pane,
        ) as create_pane_mock,
        patch("a_term.services.session_broker.project_settings_store.upsert_settings") as upsert_mock,
        patch("a_term.services.session_broker.agent_service.ensure_agent_running_sync", return_value=True) as start_mock,
    ):
        target = ensure_project_tool_session(
            project_id="a-term",
            tool_slug="claude",
            working_dir="/workspace/a_term",
        )

    assert target.session_id == "claude-3"
    assert target.pane_id == "pane-3"
    assert target.tmux_session_name == "summitflow-claude-3"
    assert target.created is True
    assert target.started is True
    create_pane_mock.assert_called_once_with(
        pane_type="project",
        pane_name="A-Term",
        project_id="a-term",
        working_dir="/workspace/a_term",
        agent_tool_slug="claude",
    )
    upsert_mock.assert_called_once_with("a-term", enabled=True, active_mode="claude")
    start_mock.assert_called_once_with("claude-3")


def test_ensure_project_tool_session_skips_matching_mode_when_working_dir_differs() -> None:
    stale_pane = _make_pane(
        "pane-1",
        "a-term",
        "codex",
        [
            _make_session("codex-home", "codex", working_dir="/home/tester/a_term"),
        ],
    )
    created_pane = _make_pane(
        "pane-2",
        "a-term",
        "codex",
        [
            _make_session("codex-workspace", "codex", working_dir="/workspace/projects/a-term"),
        ],
    )

    with (
        patch("a_term.services.session_broker.pane_store.list_panes_with_sessions", return_value=[stale_pane]),
        patch("a_term.services.session_broker.lifecycle.ensure_session_alive", return_value=True),
        patch(
            "a_term.services.session_broker.pane_store.create_pane_with_sessions",
            return_value=created_pane,
        ) as create_pane_mock,
        patch("a_term.services.session_broker.project_settings_store.upsert_settings"),
        patch("a_term.services.session_broker.agent_service.ensure_agent_running_sync", return_value=False),
    ):
        target = ensure_project_tool_session(
            project_id="a-term",
            tool_slug="codex",
            working_dir="/workspace/projects/a-term",
        )

    assert target.session_id == "codex-workspace"
    assert target.created is True
    create_pane_mock.assert_called_once_with(
        pane_type="project",
        pane_name="A-Term [2]",
        project_id="a-term",
        working_dir="/workspace/projects/a-term",
        agent_tool_slug="codex",
    )


def test_ensure_project_tool_session_skips_stale_match_and_reuses_next_live_session() -> None:
    stale = _make_pane(
        "pane-1",
        "summitflow",
        "codex",
        [
            _make_session("shell-stale", "shell", last_accessed_at="2026-03-18T15:00:00+00:00"),
            _make_session(
                "codex-stale",
                "codex",
                working_dir="/workspace/summitflow",
                last_accessed_at="2026-03-18T15:00:00+00:00",
            ),
        ],
    )
    fresh = _make_pane(
        "pane-2",
        "summitflow",
        "shell",
        [
            _make_session("shell-fresh", "shell", last_accessed_at="2026-03-18T14:00:00+00:00"),
            _make_session(
                "codex-fresh",
                "codex",
                working_dir="/workspace/summitflow",
                last_accessed_at="2026-03-18T14:00:00+00:00",
            ),
        ],
    )

    with (
        patch(
            "a_term.services.session_broker.pane_store.list_panes_with_sessions",
            side_effect=[[stale, fresh], [fresh]],
        ),
        patch(
            "a_term.services.session_broker.lifecycle.ensure_session_alive",
            side_effect=[False, True],
        ) as ensure_mock,
        patch("a_term.services.session_broker.pane_store.update_pane") as update_pane_mock,
        patch("a_term.services.session_broker.project_settings_store.upsert_settings"),
        patch("a_term.services.session_broker.agent_service.ensure_agent_running_sync", return_value=False) as start_mock,
    ):
        target = ensure_project_tool_session(
            project_id="summitflow",
            tool_slug="codex",
            working_dir="/workspace/summitflow",
        )

    assert target.session_id == "codex-fresh"
    assert target.pane_id == "pane-2"
    assert target.created is False
    ensure_mock.assert_has_calls([call("codex-stale"), call("codex-fresh")])
    update_pane_mock.assert_called_once_with("pane-2", active_mode="codex")
    start_mock.assert_called_once_with("codex-fresh")


def test_ensure_project_tool_session_reports_not_started_when_launch_fails() -> None:
    pane = _make_pane(
        "pane-1",
        "a-term",
        "codex",
        [
            _make_session(
                "codex-id",
                "codex",
                working_dir="/workspace/a_term",
                last_accessed_at="2026-03-18T14:00:00+00:00",
            ),
        ],
    )

    with (
        patch("a_term.services.session_broker.pane_store.list_panes_with_sessions", return_value=[pane]),
        patch("a_term.services.session_broker.lifecycle.ensure_session_alive", return_value=True),
        patch("a_term.services.session_broker.project_settings_store.upsert_settings"),
        patch("a_term.services.session_broker.agent_service.ensure_agent_running_sync", return_value=False),
    ):
        target = ensure_project_tool_session(
            project_id="a-term",
            tool_slug="codex",
            working_dir="/workspace/a_term",
        )

    assert target.session_id == "codex-id"
    assert target.created is False
    assert target.started is False


def test_list_project_tool_sessions_filters_stale_tmux_sessions() -> None:
    pane = _make_pane(
        "pane-1",
        "summitflow",
        "codex",
        [
            _make_session("codex-live", "codex", last_accessed_at="2026-03-18T14:00:00+00:00"),
            _make_session("codex-stale", "codex", last_accessed_at="2026-03-18T15:00:00+00:00"),
        ],
    )

    with (
        patch("a_term.services.session_broker.pane_store.list_panes_with_sessions", return_value=[pane]),
        patch(
            "a_term.services.session_broker.tmux_session_exists_by_name",
            side_effect=[True, False],
        ) as exists_mock,
    ):
        targets = list_project_tool_sessions(tool_slug="codex")

    assert [target.session_id for target in targets] == ["codex-live"]
    exists_mock.assert_has_calls(
        [
            call("summitflow-codex-live"),
            call("summitflow-codex-stale"),
        ],
    )
