"""Tests for repo identity manifest path handling."""

from __future__ import annotations

import pytest

from a_term import branding


@pytest.fixture(autouse=True)
def _allow_tmp_path_as_root(monkeypatch, tmp_path):
    monkeypatch.setattr(branding, "_allowed_root_paths", lambda: (tmp_path.resolve(),))


def test_get_project_identity_for_root_rejects_symlink_escape(tmp_path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "project.identity.json").write_text('{"project": {"id": "outside"}}')
    root = tmp_path / "root"
    root.mkdir()
    (root / "project.identity.json").symlink_to(outside / "project.identity.json")

    assert branding.get_project_identity_for_root(root) is None


def test_get_project_identity_for_root_rejects_root_symlink_escape(
    monkeypatch, tmp_path
) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    monkeypatch.setattr(branding, "_allowed_root_paths", lambda: (allowed.resolve(),))
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "project.identity.json").write_text('{"project": {"id": "outside"}}')
    root = allowed / "root-link"
    root.symlink_to(outside, target_is_directory=True)

    assert branding.get_project_identity_for_root(root) is None


def test_get_project_identity_for_root_reads_local_manifest(tmp_path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (root / "project.identity.json").write_text('{"project": {"id": "local"}}')

    assert branding.get_project_identity_for_root(root) == {"project": {"id": "local"}}


def test_get_project_identity_for_root_rejects_missing_root(tmp_path) -> None:
    assert branding.get_project_identity_for_root(tmp_path / "missing") is None


def test_get_project_identity_for_root_rejects_file_root(tmp_path) -> None:
    root = tmp_path / "not-a-directory"
    root.write_text('{"project": {"id": "local"}}')

    assert branding.get_project_identity_for_root(root) is None


def test_get_project_identity_for_root_rejects_path_outside_allowed_roots(
    monkeypatch, tmp_path
) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    monkeypatch.setattr(branding, "_allowed_root_paths", lambda: (allowed.resolve(),))

    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "project.identity.json").write_text('{"project": {"id": "outside"}}')

    assert branding.get_project_identity_for_root(outside) is None
