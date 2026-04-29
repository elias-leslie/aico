"""Tests for release version bump safety."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


def test_bump_version_updates_only_project_version(tmp_path) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    (tmp_path / "frontend").mkdir()
    (tmp_path / "packages" / "notes-ui").mkdir(parents=True)
    (tmp_path / "pyproject.toml").write_text(
        """[build-system]
requires = ["hatchling"]

[tool.example]
version = "9.9.9"

[project]
name = "a-term"
version = "0.2.8"
""",
        encoding="utf-8",
    )
    (tmp_path / "uv.lock").write_text(
        """[[package]]
name = "other"
version = "9.9.9"

[[package]]
name = "a-term"
version = "0.2.8"
""",
        encoding="utf-8",
    )
    (tmp_path / "frontend" / "package.json").write_text(
        json.dumps({"name": "frontend", "version": "0.2.8"}),
        encoding="utf-8",
    )
    (tmp_path / "packages" / "notes-ui" / "package.json").write_text(
        json.dumps({"name": "notes-ui", "version": "0.2.8"}),
        encoding="utf-8",
    )

    result = subprocess.run(
        ["bash", str(repo_root / "scripts" / "bump-version.sh"), "0.3.0"],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert 'version = "9.9.9"' in (tmp_path / "pyproject.toml").read_text(encoding="utf-8")
    assert '[project]\nname = "a-term"\nversion = "0.3.0"' in (
        tmp_path / "pyproject.toml"
    ).read_text(encoding="utf-8")
    assert 'name = "other"\nversion = "9.9.9"' in (tmp_path / "uv.lock").read_text(
        encoding="utf-8"
    )
    assert 'name = "a-term"\nversion = "0.3.0"' in (tmp_path / "uv.lock").read_text(
        encoding="utf-8"
    )
    assert json.loads((tmp_path / "frontend" / "package.json").read_text())["version"] == "0.3.0"
    assert json.loads((tmp_path / "packages" / "notes-ui" / "package.json").read_text())[
        "version"
    ] == "0.3.0"
