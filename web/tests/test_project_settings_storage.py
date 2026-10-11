"""Per-project display settings in SQLite."""

from __future__ import annotations

from a_term.storage import project_settings as store


def test_upsert_creates_then_changes_only_given_fields() -> None:
    created = store.upsert_settings("a", enabled=True, active_mode="codex")
    assert created["enabled"] is True and created["active_mode"] == "codex" and created["display_order"] == 0
    changed = store.upsert_settings("a", display_order=4)
    assert changed["enabled"] is True and changed["active_mode"] == "codex" and changed["display_order"] == 4
    assert store.upsert_settings("b")["enabled"] is False


def test_order_mode_and_listing() -> None:
    for project in ("a", "b", "c"):
        store.upsert_settings(project, enabled=True)
    store.bulk_update_order(["c", "a", "b"])
    assert list(store.get_all_settings()) == ["c", "a", "b"]
    assert store.set_active_mode("a", "claude-code")["active_mode"] == "claude-code"  # type: ignore[index]
    assert store.set_active_mode("missing", "shell") is None
    assert store.get_settings("missing") is None


def test_prune_keeps_valid_and_refuses_empty_catalog() -> None:
    for project in ("a", "b", "c"):
        store.upsert_settings(project)
    assert store.prune_missing_projects(set()) == 0
    assert store.prune_missing_projects({"a"}) == 2
    assert list(store.get_all_settings()) == ["a"]
