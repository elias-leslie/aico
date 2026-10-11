"""Pane view state in SQLite: panes, layout and session links."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from a_term.constants import MAX_PANES
from a_term.storage import local_db
from a_term.storage import panes as store


def _project(name: str = "P", **kwargs: object) -> dict:
    return store.create_pane(pane_type="project", pane_name=name, project_id="proj", **kwargs)


def test_create_validates_type_and_project() -> None:
    with pytest.raises(ValueError):
        store.create_pane(pane_type="project", pane_name="x")
    with pytest.raises(ValueError):
        store.create_pane(pane_type="adhoc", pane_name="x", project_id="p")


def test_crud_roundtrip_and_ordering() -> None:
    first = _project("A")
    second = store.create_pane(pane_type="adhoc", pane_name="B")
    assert (first["pane_order"], second["pane_order"]) == (0, 1)
    assert first["is_detached"] is False

    updated = store.update_pane(first["id"], pane_name="A2", width_percent=50.0, bogus="ignored")
    assert updated is not None and updated["pane_name"] == "A2" and updated["width_percent"] == 50.0

    assert store.swap_pane_positions(first["id"], second["id"])
    assert store.get_pane(first["id"])["pane_order"] == 1  # type: ignore[index]

    store.detach_pane(first["id"])
    assert [pane["id"] for pane in store.list_panes()] == [second["id"]]
    assert len(store.list_panes(include_detached=True)) == 2
    attached = store.attach_pane(first["id"])
    assert attached is not None and attached["is_detached"] is False

    assert store.delete_pane(first["id"])
    assert store.get_pane(first["id"]) is None
    assert not store.delete_pane(first["id"])


def test_layouts_update_only_given_fields() -> None:
    pane = _project()
    result = store.update_pane_layouts([{"pane_id": pane["id"], "grid_row": 1}, {"grid_row": 9}])
    assert len(result) == 1
    assert result[0]["grid_row"] == 1 and result[0]["width_percent"] == 100.0


def test_links_belong_to_one_pane_and_cascade() -> None:
    a, b = _project("A"), _project("B")
    store.link_session("aaaaaaaa", a["id"], "shell")
    store.link_session("aaaaaaaa", b["id"], "codex")
    link = store.get_link("aaaaaaaa")
    assert link is not None and link["pane_id"] == b["id"] and link["mode"] == "codex" and link["kind"] == "tether"
    store.link_session("bbbbbbbb", b["id"], "shell", kind="legacy")
    assert [row["session_id"] for row in store.links_for_pane(b["id"])] == ["aaaaaaaa", "bbbbbbbb"]

    store.update_link("aaaaaaaa", mode="claude-code", display_order=3, pane_id="ignored")
    store.touch_link("aaaaaaaa")
    link = store.get_link("aaaaaaaa")
    assert link["mode"] == "claude-code" and link["display_order"] == 3  # type: ignore[index]

    assert store.unlink_session("bbbbbbbb")
    assert not store.unlink_session("bbbbbbbb")
    store.delete_pane(b["id"])
    assert store.list_links() == []


def test_max_panes_counts_only_visible_linked_panes() -> None:
    for index in range(MAX_PANES):
        pane = _project(f"P{index}")
        store.link_session(f"{index:08x}", pane["id"], "shell")
    # Empty and detached panes do not count.
    store.create_pane(pane_type="adhoc", pane_name="detached", is_detached=True)
    with pytest.raises(ValueError, match="Maximum"):
        _project("one too many")
    detached = store.list_panes(include_detached=True)[-1]
    store.link_session("ffffffff", detached["id"], "shell")
    with pytest.raises(ValueError, match="Maximum"):
        store.attach_pane(detached["id"])
    assert store.count_panes() == MAX_PANES
    assert store.count_panes(include_detached=True) == MAX_PANES + 1


def test_delete_empty_panes_only_old_and_unlinked() -> None:
    old_empty = _project("old empty")
    old_linked = _project("old linked")
    _project("new empty")
    store.link_session("aaaaaaaa", old_linked["id"], "shell")
    past = (datetime.now(UTC) - timedelta(days=30)).isoformat()
    with local_db.connect() as db:
        db.execute("UPDATE panes SET created_at = ? WHERE id IN (?, ?)", (past, old_empty["id"], old_linked["id"]))
    assert store.delete_empty_panes(7) == 1
    assert store.get_pane(old_empty["id"]) is None
    assert store.get_pane(old_linked["id"]) is not None
