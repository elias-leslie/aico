from __future__ import annotations

import subprocess
from pathlib import Path


def test_frontend_project_branding_module_is_in_sync() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", "frontend/scripts/generate-project-branding.mjs", "--check"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr or result.stdout
