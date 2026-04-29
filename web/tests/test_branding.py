"""Tests for repo identity manifest path handling."""

from __future__ import annotations

import os

from a_term import branding


def test_get_project_identity_for_root_rejects_symlink_escape(tmp_path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "project.identity.json").write_text('{"project": {"id": "outside"}}')
    root = tmp_path / "root"
    root.mkdir()
    (root / "project.identity.json").symlink_to(outside / "project.identity.json")

    assert branding.get_project_identity_for_root(root) is None


def test_get_project_identity_for_root_reads_local_manifest(tmp_path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (root / "project.identity.json").write_text('{"project": {"id": "local"}}')

    assert branding.get_project_identity_for_root(root) == {"project": {"id": "local"}}


def test_get_project_identity_for_root_rejects_commonpath_value_error(
    tmp_path,
    monkeypatch,
) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (root / "project.identity.json").write_text('{"project": {"id": "local"}}')

    def raise_value_error(_paths: list[str]) -> str:
        raise ValueError("paths are on different drives")

    monkeypatch.setattr(os.path, "commonpath", raise_value_error)

    assert branding.get_project_identity_for_root(root) is None
