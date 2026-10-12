"""`st aico layout`: the running GUI's window picture, read-only."""

import json

from test_aico_admin import admin


def test_prints_layout(tmp_path, monkeypatch, capsys):
    path = tmp_path / "layout.json"
    path.write_text(json.dumps({"v": 1, "updatedAt": "x", "displays": [], "windows": [
        {"id": "aabbcc01", "bounds": {"x": 0, "y": 0, "width": 900, "height": 560}}]}))
    monkeypatch.setenv("AICO_LAYOUT_FILE", str(path))
    assert admin.main(["layout"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["owner"] == "aico" and out["windows"][0]["id"] == "aabbcc01"


def test_missing_layout_is_unavailable(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("AICO_LAYOUT_FILE", str(tmp_path / "none.json"))
    assert admin.main(["layout"]) == 1
    assert json.loads(capsys.readouterr().out)["reason"] == "layout_missing"
