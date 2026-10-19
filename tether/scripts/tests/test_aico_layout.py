"""`st aico layout`: the running GUI's window picture, read-only."""

import json
import os
import subprocess
import sys

from test_aico_admin import admin


def own_start_time() -> str:
    with open(f"/proc/{os.getpid()}/stat") as stream:
        stat = stream.read()
    return stat[stat.rindex(")") + 1:].split()[19]


def live_owner() -> dict:
    """The pid and start time a running Aico writes: this test process."""
    return {"pid": os.getpid(), "startTime": own_start_time()}


def write_layout(tmp_path, monkeypatch, data) -> None:
    path = tmp_path / "layout.json"
    path.write_text(json.dumps(data))
    monkeypatch.setenv("AICO_LAYOUT_FILE", str(path))


def test_prints_layout(tmp_path, monkeypatch, capsys):
    write_layout(tmp_path, monkeypatch, {"v": 1, **live_owner(), "updatedAt": "x", "displays": [], "windows": [
        {"id": "aabbcc01", "bounds": {"x": 0, "y": 0, "width": 900, "height": 560}}]})
    assert admin.main(["layout"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["owner"] == "aico" and out["windows"][0]["id"] == "aabbcc01"


def test_missing_layout_is_unavailable(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("AICO_LAYOUT_FILE", str(tmp_path / "none.json"))
    assert admin.main(["layout"]) == 1
    assert json.loads(capsys.readouterr().out)["reason"] == "layout_missing"


def test_layout_from_a_dead_aico_is_stale(tmp_path, monkeypatch, capsys):
    # A SIGKILLed Aico never runs its quit cleanup, so its file stays behind.
    gone = subprocess.run([sys.executable, "-c", "import os; print(os.getpid())"],
                          capture_output=True, text=True, check=True)
    write_layout(tmp_path, monkeypatch, {"v": 1, "pid": int(gone.stdout), "startTime": "1", "windows": []})
    assert admin.main(["layout"]) == 1
    assert json.loads(capsys.readouterr().out) == {
        "owner": "aico", "observation": "unavailable", "reason": "layout_stale"}


def test_layout_whose_pid_was_reused_is_stale(tmp_path, monkeypatch, capsys):
    # The pid is alive but names a later process: its start time differs.
    write_layout(tmp_path, monkeypatch, {"v": 1, "pid": os.getpid(),
                                         "startTime": str(int(own_start_time()) + 1), "windows": []})
    assert admin.main(["layout"]) == 1
    assert json.loads(capsys.readouterr().out)["reason"] == "layout_stale"


def test_layout_without_a_start_time_trusts_a_live_pid(tmp_path, monkeypatch, capsys):
    # Aico writes startTime null when it could not read procfs itself.
    write_layout(tmp_path, monkeypatch, {"v": 1, "pid": os.getpid(), "startTime": None, "windows": []})
    assert admin.main(["layout"]) == 0
    assert json.loads(capsys.readouterr().out)["pid"] == os.getpid()


def test_layout_without_a_writer_pid_is_unqualified(tmp_path, monkeypatch, capsys):
    # Every Aico since layout.json named its writer sets pid; without it the
    # file can't be told apart from a crash leftover.
    for owner in ({}, {"pid": "12"}, {"pid": True}, {"pid": 0}, {"pid": os.getpid(), "startTime": 5}):
        write_layout(tmp_path, monkeypatch, {"v": 1, **owner, "windows": []})
        assert admin.main(["layout"]) == 1
        assert json.loads(capsys.readouterr().out)["reason"] == "layout_unqualified", owner
