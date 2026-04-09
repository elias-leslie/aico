from __future__ import annotations

import json
from pathlib import Path

import yaml


def test_project_index_runtime_ports_match_identity_manifest() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    identity = json.loads((repo_root / "project.identity.json").read_text())
    project_index = yaml.safe_load((repo_root / ".index.yaml").read_text())

    backend_port = identity["runtime"]["backend_port"]
    frontend_port = identity["runtime"]["frontend_port"]

    assert project_index["services"]["backend_port"] == identity["runtime"]["backend_port"]
    assert project_index["services"]["frontend_port"] == identity["runtime"]["frontend_port"]
    assert project_index["urls"]["api"] == f"http://localhost:{backend_port}/api"
    assert project_index["urls"]["frontend"] == f"http://localhost:{frontend_port}"
