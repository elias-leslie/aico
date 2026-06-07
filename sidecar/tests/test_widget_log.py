"""Per-widget JSONL logging: a widget action emits one JSONL line."""

import json

import pytest
from fastapi.testclient import TestClient

from aico_sidecar.app import create_app
from aico_sidecar.config import Settings
from aico_sidecar.widget_log import WidgetLog, is_valid_widget_id


def test_widget_event_appends_jsonl_line(tmp_path) -> None:
    client = TestClient(create_app(Settings(state_dir=tmp_path)))

    resp = client.post("/widgets/a1b2c3d4/events", json={"event": "open", "data": {"cols": 80}})
    assert resp.status_code == 200
    assert resp.json()["logged"] is True

    log_file = tmp_path / "logs" / "a1b2c3d4.jsonl"
    lines = log_file.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["widget_id"] == "a1b2c3d4"
    assert record["event"] == "open"
    assert record["data"] == {"cols": 80}
    assert record["ts"].endswith("Z")


def test_appends_accumulate(tmp_path) -> None:
    log = WidgetLog(tmp_path / "logs")
    log.append("w1", "open")
    log.append("w1", "close")
    lines = (tmp_path / "logs" / "w1.jsonl").read_text(encoding="utf-8").splitlines()
    assert [json.loads(line)["event"] for line in lines] == ["open", "close"]


def test_invalid_widget_id_rejected_by_api(tmp_path) -> None:
    client = TestClient(create_app(Settings(state_dir=tmp_path)))
    resp = client.post("/widgets/..%2Fetc/events", json={"event": "open"})
    assert resp.status_code in (404, 422)


def test_oversized_event_data_rejected(tmp_path) -> None:
    from aico_sidecar.app import WIDGET_EVENT_DATA_CAP

    client = TestClient(create_app(Settings(state_dir=tmp_path)))
    huge = {"blob": "x" * (WIDGET_EVENT_DATA_CAP + 1)}
    resp = client.post("/widgets/a1b2c3d4/events", json={"event": "open", "data": huge})
    assert resp.status_code == 422


@pytest.mark.parametrize(
    ("widget_id", "ok"),
    [("a1b2c3d4", True), ("aico-1", True), ("", False), ("../etc", False), ("a/b", False)],
)
def test_widget_id_validation(widget_id: str, ok: bool) -> None:
    assert is_valid_widget_id(widget_id) is ok


def test_logger_rejects_traversal(tmp_path) -> None:
    log = WidgetLog(tmp_path / "logs")
    with pytest.raises(ValueError, match="invalid widget id"):
        log.append("../escape", "open")


def test_log_rotates_past_max(tmp_path, monkeypatch) -> None:
    from aico_sidecar import widget_log

    monkeypatch.setattr(widget_log, "MAX_LOG_BYTES", 200)
    log = widget_log.WidgetLog(tmp_path / "logs")
    for i in range(50):
        log.append("w1", "event", {"i": i})
    primary = tmp_path / "logs" / "w1.jsonl"
    backup = tmp_path / "logs" / "w1.jsonl.1"
    assert backup.exists()  # rolled over at least once
    # The live file holds only lines written since the last rotation, so it stays
    # bounded near the cap rather than accumulating all 50 events.
    assert primary.stat().st_size < 200 + 200
