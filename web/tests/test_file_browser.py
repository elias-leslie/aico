"""Tests for pane file-browser path safety."""

from __future__ import annotations

import pytest

from a_term.services import file_browser


def test_resolve_safe_path_rejects_absolute_paths(tmp_path) -> None:
    with pytest.raises(PermissionError, match="absolute paths"):
        file_browser.resolve_safe_path(str(tmp_path), "/etc/passwd")


def test_resolve_safe_path_rejects_parent_traversal(tmp_path) -> None:
    with pytest.raises(PermissionError, match=r"\.\."):
        file_browser.resolve_safe_path(str(tmp_path), "../secret.txt")


def test_resolve_safe_path_rejects_forbidden_dirs(tmp_path) -> None:
    with pytest.raises(PermissionError, match=r"\.git"):
        file_browser.resolve_safe_path(str(tmp_path), ".git/config")


def test_resolve_safe_path_allows_child_paths(tmp_path) -> None:
    child = tmp_path / "src" / "README.md"
    child.parent.mkdir()
    child.write_text("hello")

    assert file_browser.resolve_safe_path(str(tmp_path), "src/README.md") == child
