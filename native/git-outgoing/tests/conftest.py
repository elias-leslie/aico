import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def private_heavy_lane(tmp_path, monkeypatch):
    """Keep tests off the host's shared heavy-work lane and admission state: a live suite holding the lane would
    otherwise queue every verification (and the pre-push adapter subprocesses, via the env override)."""
    from git_outgoing import heavy_work

    lane = tmp_path / "heavy-lane"
    monkeypatch.setenv("ST_HEAVY_LOCK_DIR", str(lane))
    monkeypatch.setattr(heavy_work, "_LOCK_DIRECTORY", lane)
    monkeypatch.setattr(heavy_work, "HOST_ADMISSION", tmp_path / "host-admission.json")
    monkeypatch.setattr(heavy_work, "_PSI_MEMORY", tmp_path / "psi-memory")
