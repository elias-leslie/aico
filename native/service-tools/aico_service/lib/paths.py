"""Paths owned by the Aico CLI; deployed service state keeps its existing location."""

import os
from pathlib import Path


def get_repo_root() -> Path:
    return Path(os.environ.get("AICO_REPO_ROOT") or Path(__file__).resolve().parents[4]).resolve()
