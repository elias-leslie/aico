from __future__ import annotations

import json
from pathlib import Path


def test_notes_ui_dependency_is_repo_local() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    package_json = json.loads((repo_root / "frontend" / "package.json").read_text())
    dependency = package_json["dependencies"]["@summitflow/notes-ui"]

    assert dependency == "file:../packages/notes-ui"

    package_path = (repo_root / "frontend" / dependency.removeprefix("file:")).resolve()
    assert package_path.is_dir()
    assert package_path.is_relative_to(repo_root)
