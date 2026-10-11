"""Projects API: Tether's project list merged with A-Term's tab settings."""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from a_term.rate_limit import limiter
from a_term.storage import panes as pane_store
from a_term.storage import project_settings as settings_store

from .fake_tether import FakeTether


@pytest.fixture(autouse=True)
def _reset_rate_limits() -> Iterator[None]:
    limiter.reset()
    yield
    limiter.reset()


@pytest.fixture()
def projects(fake_tether: FakeTether, local_state: Path) -> list[dict[str, str]]:
    alpha, beta = local_state / "alpha", local_state / "beta"
    alpha.mkdir()
    beta.mkdir()
    fake_tether.state.projects = [
        {"id": "alpha", "name": "Alpha", "root": str(alpha), "lifecycle": "active"},
        {"id": "beta", "name": "Beta", "root": str(beta), "lifecycle": "active"},
    ]
    return fake_tether.state.projects


def test_list_projects_merges_settings(test_app: TestClient, projects: list[dict[str, str]]) -> None:
    settings_store.upsert_settings("beta", enabled=True, active_mode="codex", display_order=0)
    settings_store.upsert_settings("alpha", enabled=False, display_order=1)
    body = test_app.get("/api/a-term/projects").json()
    assert [(p["id"], p["a_term_enabled"], p["mode"]) for p in body] == [
        ("beta", True, "codex"),
        ("alpha", False, "shell"),
    ]
    assert body[0]["root_path"] == projects[1]["root"]


def test_list_projects_tether_down_is_503(test_app: TestClient, fake_tether: FakeTether) -> None:
    fake_tether.stop()
    response = test_app.get("/api/a-term/projects")
    assert response.status_code == 503


def test_set_mode_and_settings(test_app: TestClient, projects: list[dict[str, str]]) -> None:
    mode = test_app.put("/api/a-term/projects/alpha/mode", json={"mode": "claude-code"})
    assert mode.status_code == 200
    assert mode.json()["mode"] == "claude-code"
    assert test_app.put("/api/a-term/projects/alpha/mode", json={"mode": "Bad Mode"}).status_code == 422

    updated = test_app.put("/api/a-term/project-settings/alpha", json={"enabled": True, "display_order": 4})
    assert updated.json()["a_term_enabled"] is True
    assert updated.json()["display_order"] == 4

    ordered = test_app.post("/api/a-term/project-settings/bulk-order", json={"project_ids": ["beta", "alpha"]})
    assert [p["id"] for p in ordered.json()] == ["beta", "alpha"]


def test_context_reports_source(test_app: TestClient, fake_tether: FakeTether) -> None:
    assert test_app.get("/api/a-term/projects/context").json() == {"source": "local", "can_register": True}
    fake_tether.state.project_source = "summitflow"
    assert test_app.get("/api/a-term/projects/context").json() == {"source": "companion", "can_register": False}


def test_register_project_writes_tether_local_file(
    test_app: TestClient, fake_tether: FakeTether, local_state: Path
) -> None:
    root = local_state / "gamma"
    root.mkdir()
    response = test_app.post("/api/a-term/projects", json={"root_path": str(root), "name": "Gamma Project"})
    assert response.status_code == 200, response.text
    assert response.json()["id"] == "gamma-project"
    entries = json.loads(Path(os.environ["TETHER_PROJECTS_FILE"]).read_text())
    assert entries == [{"id": "gamma-project", "name": "Gamma Project", "root": str(root)}]

    again = test_app.post("/api/a-term/projects", json={"root_path": str(root)})
    assert again.json()["id"] == "gamma-project"
    assert len(json.loads(Path(os.environ["TETHER_PROJECTS_FILE"]).read_text())) == 1


def test_register_rejects_missing_path(test_app: TestClient, fake_tether: FakeTether, local_state: Path) -> None:
    response = test_app.post("/api/a-term/projects", json={"root_path": str(local_state / "nope")})
    assert response.status_code == 400


def test_register_refused_when_summitflow_supplies_projects(
    test_app: TestClient, fake_tether: FakeTether, local_state: Path
) -> None:
    fake_tether.state.project_source = "summitflow"
    response = test_app.post("/api/a-term/projects", json={"root_path": str(local_state)})
    assert response.status_code == 409
    assert not Path(os.environ["TETHER_PROJECTS_FILE"]).exists()


def test_reset_project_creates_missing_sessions(
    test_app: TestClient, fake_tether: FakeTether, projects: list[dict[str, str]]
) -> None:
    response = test_app.post("/api/a-term/projects/alpha/reset")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["agent_mode"] == "codex"
    assert body["shell_session_id"] in fake_tether.state.sessions
    assert body["agent_session_id"] in fake_tether.state.sessions
    assert fake_tether.state.sessions[body["shell_session_id"]]["projectRoot"] == projects[0]["root"]
    assert settings_store.get_settings("alpha")["active_mode"] == "shell"  # type: ignore[index]


def test_disable_project_ends_sessions_and_panes(
    test_app: TestClient, fake_tether: FakeTether, projects: list[dict[str, str]]
) -> None:
    created = test_app.post(
        "/api/a-term/panes", json={"pane_type": "project", "pane_name": "Alpha", "project_id": "alpha"}
    ).json()
    response = test_app.post("/api/a-term/projects/alpha/disable")
    assert response.status_code == 200
    assert response.json()["a_term_enabled"] is False
    assert fake_tether.state.sessions == {}
    assert pane_store.get_pane(created["id"]) is None
