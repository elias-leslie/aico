"""Aico's supported local CLI seam; never import an application package."""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any


def run(*args: str) -> subprocess.CompletedProcess[str]:
    """Run the installed Aico command (or an explicitly selected executable)."""
    return subprocess.run(
        [os.environ.get("AICO_CLI", "aico"), *args],
        capture_output=True, text=True, check=False,
    )


def run_json(*args: str) -> Any:
    try:
        result = run(*args)
        return json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, ValueError):
        return None
