import json

from git_outgoing import heavy_work


def test_wait_reason_stays_readable_and_wait_lines_back_off(monkeypatch, tmp_path):
    decision = tmp_path / "admission.json"
    monkeypatch.setattr(heavy_work, "HOST_ADMISSION", decision)
    decision.write_text(json.dumps({"v": 1, "expires_at": 101, "admit": False, "state": "amber",
                                    "reason": "Memory is tight: 12.8 GiB available, swap 47% (parked, no stalls); defer"}))
    assert heavy_work.admission_state(100).reason == (
        "host amber: Memory is tight: 12.8 GiB available, swap 47% (parked, no stalls); defer")
    clock = iter([0.0, 3.0, 20.0, 500.0])
    monkeypatch.setattr(heavy_work.time, "monotonic", lambda: next(clock))
    assert [heavy_work._next_status(0.0) for _ in range(4)] == [5.0, 8.0, 40.0, 560.0]
