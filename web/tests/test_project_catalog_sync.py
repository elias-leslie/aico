"""A-Term project discovery must not rewrite the shared project registry."""

from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import MagicMock

from a_term.storage import projects


def _database(monkeypatch, *, owner_catalog: bool) -> tuple[MagicMock, MagicMock]:
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = {
        "retirement_table": "project_retirement_decisions" if owner_catalog else None
    }

    @contextmanager
    def get_connection():
        yield connection

    monkeypatch.setattr(projects, "get_connection", get_connection)
    return connection, cursor


def test_owner_catalog_project_list_does_not_sync_manifests(monkeypatch) -> None:
    connection, cursor = _database(monkeypatch, owner_catalog=True)
    monkeypatch.setattr(
        projects,
        "list_workspace_project_identities",
        lambda: ({"id": "a-term", "root_path": "/release/source"},),
    )

    assert projects.sync_workspace_projects() == 0
    assert cursor.execute.call_count == 1
    connection.commit.assert_not_called()


def test_legacy_catalog_only_inserts_missing_projects(monkeypatch) -> None:
    connection, cursor = _database(monkeypatch, owner_catalog=False)
    cursor.rowcount = 0  # The ID already exists in the registry.
    monkeypatch.setattr(
        projects,
        "list_workspace_project_identities",
        lambda: ({
            "id": "a-term",
            "display_name": "A-Term",
            "root_path": "/checkout/a-term",
        },),
    )

    assert projects.sync_workspace_projects() == 0
    insert_sql = cursor.execute.call_args_list[-1].args[0]
    assert "ON CONFLICT (id) DO NOTHING" in insert_sql
    assert "DO UPDATE" not in insert_sql
    connection.commit.assert_called_once()


def test_owner_catalog_list_excludes_testing_and_retired_projects(monkeypatch) -> None:
    _, cursor = _database(monkeypatch, owner_catalog=True)
    cursor.fetchall.return_value = [{
        "id": "aico",
        "name": "Aico",
        "root_path": "/checkout/aico",
        "created_at": None,
    }]

    assert [row["id"] for row in projects.list_projects()] == ["aico"]
    select_sql = cursor.execute.call_args_list[-1].args[0]
    assert "category <> 'testing'" in select_sql
    assert "project_retirement_decisions" in select_sql
