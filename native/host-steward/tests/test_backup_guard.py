"""Synthetic local sensors and stubbed cgroups: no heat, network or live exports."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pve-sender"))
from pve_sender import backup_guard as guard

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def cfg(tmp_path):
    value = guard.config(ROOT / "native/pve-sender/backup-guard.json")
    value.update(runtime_dir=str(tmp_path / "run"), state_dir=str(tmp_path / "state"),
                 hwmon_root=str(tmp_path / "hwmon"), boot_id_path=str(tmp_path / "boot-id"))
    Path(value["boot_id_path"]).write_text("this-boot")
    return value


def snapshot(cfg):
    return guard.load(Path(cfg["runtime_dir"]) / "status.json")


def sample(cfg, state, temperature, now, calls, **kwargs):
    return guard.tick(cfg, state, now=now, sample=lambda _cfg: temperature,
                      enforce=lambda _cfg, mode: calls.append(mode), **kwargs)


def test_policy_controls_below_hardware_maximum_and_is_modest(cfg):
    assert cfg["recover_c"] < cfg["hot_c"] < cfg["critical_c"] < 95
    assert cfg["normal_cpu_percent"] == 50
    assert cfg["sample_s"] == 15 and cfg["stale_s"] == 45


def test_hot_requires_two_samples_critical_is_immediate_and_recovery_has_hysteresis(cfg):
    calls = []
    state = sample(cfg, {}, 60, 100, calls, starting=True)
    assert snapshot(cfg)["admission_open"]
    state = sample(cfg, state, 85, 115, calls)
    assert state["mode"] == "normal"
    state = sample(cfg, state, 85, 130, calls)
    assert state["mode"] == "hot" and not snapshot(cfg)["admission_open"]
    episode = state["episode"]["id"]
    state = sample(cfg, state, 84, 145, calls)
    assert state["mode"] == "hot"
    state = sample(cfg, state, 90, 160, calls)
    assert state["mode"] == "critical" and state["episode"]["id"] == episode
    state = sample(cfg, state, 86, 175, calls)
    assert state["mode"] == "critical"
    state = sample(cfg, state, 80, 190, calls)
    assert state["mode"] == "normal"
    assert state["episode"] == {"id": episode, "started_at": 130,
                                "peak_mode": "critical", "ended_at": 190}
    assert calls == ["normal", "hot", "critical", "normal"]


def test_isolated_hot_sample_and_missing_sample_do_not_accumulate(cfg):
    state = {}
    for temperature in (85, 84, 85, None, 85):
        state = sample(cfg, state, temperature, 100, [])
    assert state["mode"] == "normal" and state["episode"]["ended_at"] == 100
    assert state["episode"]["peak_mode"] == "unavailable"


def test_missing_sensor_blocks_admission_but_retains_existing_cpu_ceiling(cfg):
    calls = []
    state = sample(cfg, {}, None, 100, calls, starting=True)
    assert state["mode"] == "unavailable" and snapshot(cfg)["cpu_quota_percent"] == 50
    assert state["episode"]["id"] == "sensor:this-boot"
    with pytest.raises(guard.Deferred):
        guard.admission(cfg, snapshot(cfg), 100)
    state = sample(cfg, state, 90, 115, calls)
    episode = state["episode"]["id"]
    state = sample(cfg, state, None, 130, calls)
    assert snapshot(cfg)["cpu_quota_percent"] == 10
    assert state["episode"]["id"] == episode
    state = sample(cfg, state, 80, 145, calls)
    assert snapshot(cfg)["admission_open"]
    assert calls == ["normal", "critical", "normal"]


def test_restart_retains_heat_and_episode_until_a_fresh_recovery_sample(cfg):
    state = sample(cfg, {}, 90, 100, [])
    saved = guard.load(Path(cfg["state_dir"]) / "state.json")
    assert "hot_count" not in saved
    calls = []
    restarted = sample(cfg, saved, 84, 10000, calls, starting=True)
    assert restarted["mode"] == "critical"
    assert restarted["episode"] == state["episode"]
    recovered = sample(cfg, restarted, 80, 10015, calls)
    assert recovered["mode"] == "normal"
    assert calls == ["critical", "normal"]


def test_only_transitions_write_durable_state_and_ticks_stay_silent(cfg, capsys):
    state = sample(cfg, {}, 60, 100, [], starting=True)
    path = Path(cfg["state_dir"]) / "state.json"
    os.utime(path, ns=(1, 1))
    for now, temperature in ((115, 65), (130, 85), (145, 84)):
        state = sample(cfg, state, temperature, now, [])
    assert path.stat().st_mtime_ns == 1
    assert snapshot(cfg)["observed_at"] == 145
    assert capsys.readouterr().out == capsys.readouterr().err == ""


def test_admission_refuses_stale_future_other_boot_and_unreadable_status(cfg):
    sample(cfg, {}, 60, 100, [], starting=True)
    value = snapshot(cfg)
    guard.admission(cfg, value, 145)
    for now, changes in ((146, {}), (99, {}), (100, {"boot_id": "old-boot"}),
                         (100, {"observed_at": float("nan")}), (100, {})):
        item = {} if now == 100 and not changes else {**value, **changes}
        with pytest.raises(guard.Deferred):
            guard.admission(cfg, item, now)


def test_sensor_reads_only_configured_cpu_input_and_rediscovers_after_removal(cfg, monkeypatch):
    hw = Path(cfg["hwmon_root"]) / "hwmon3"
    hw.mkdir(parents=True)
    (hw / "name").write_text("k10temp")
    (hw / "temp1_label").write_text("Tctl")
    (hw / "temp1_input").write_text("65000")
    (hw / "temp2_label").write_text("Tdie")
    (hw / "temp2_input").write_text("99000")
    assert guard.cpu_temperature(cfg) == 65
    seen = []
    original = Path.read_text

    def read(path, *args, **kwargs):
        seen.append(path)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read)
    assert guard.cpu_temperature(cfg) == 65
    assert seen == [hw / "temp1_input"]
    (hw / "temp1_input").unlink()
    assert guard.cpu_temperature(cfg) is None
    (hw / "temp1_input").write_text("0")
    assert guard.cpu_temperature(cfg) is None


def test_host_export_is_inside_fixed_scope_and_single_host_slot(cfg):
    sample(cfg, {}, 60, 100, [], starting=True)
    calls = []

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        # Simulate a second independent caller while the export is still running.
        with pytest.raises(guard.Deferred, match="active host export"):
            guard.run_export(cfg, ["second-export"], run=run, now=100)
        return SimpleNamespace(returncode=7)

    assert guard.run_export(cfg, ["actual-export", "source"], run=run, now=100) == 7
    assert calls == [(["systemctl", "--no-ask-password", "is-active", "--quiet",
                       "aico-backup-export.scope"], {"check": False, "capture_output": True}),
                     (["systemd-run", "--scope", "--quiet", "--collect",
                       "--unit=aico-backup-export.scope", "--slice=aico-backup.slice",
                       "--", "actual-export", "source"], {"check": False})]


def test_scope_survives_lost_caller_and_defers_next_export(cfg):
    sample(cfg, {}, 60, 100, [], starting=True)
    calls = []

    def active(argv, **_kwargs):
        calls.append(argv)
        return SimpleNamespace(returncode=0)

    with pytest.raises(guard.Deferred, match="active host export"):
        guard.run_export(cfg, ["export"], run=active, now=100)
    assert calls == [["systemctl", "--no-ask-password", "is-active", "--quiet",
                      "aico-backup-export.scope"]]


def test_no_export_is_started_when_guard_is_unavailable_or_hot(cfg):
    def forbidden(*_args, **_kwargs):
        pytest.fail("A deferred job must not run.")

    for temperature in (None, 90):
        sample(cfg, {}, temperature, 100, [], starting=True)
        with pytest.raises(guard.Deferred):
            guard.run_export(cfg, ["export"], run=forbidden, now=100)


def test_quota_commands_target_backup_slice_only_and_failure_cannot_publish_admission(cfg):
    calls = []
    guard.set_quota(cfg, "hot", run=lambda argv, **kwargs: calls.append((argv, kwargs)))
    assert calls == [(["systemctl", "--no-ask-password", "set-property", "--runtime",
                       "aico-backup.slice", "CPUQuota=20%"],
                      {"check": True, "capture_output": True, "text": True})]

    def fail(*_args):
        raise OSError("cgroup write failed")

    with pytest.raises(OSError):
        guard.tick(cfg, {}, now=100, sample=lambda _: 60, enforce=fail, starting=True)
    assert snapshot(cfg) == {}


def test_budget_is_read_only_and_keeps_last_ceiling_for_running_guest_when_stale(cfg):
    sample(cfg, {}, 90, 100, [], starting=True)
    assert guard.budget(cfg, now=100) == {"quotaPercent": 10, "admit": False, "sampleSeconds": 15}
    assert guard.budget(cfg, now=200) == {"quotaPercent": 10, "admit": False, "sampleSeconds": 15}
    assert not (Path(cfg["runtime_dir"]) / "export.lock").exists()


def test_notice_payload_has_one_heat_episode_and_boot_scoped_missing_sensor(cfg):
    unavailable = guard.notice_payload(cfg, {}, 100)
    assert unavailable == {"episode_id": "sensor:this-boot", "phase": "unavailable",
                           "temperature_c": None, "cpu_quota_percent": 50,
                           "admission_open": False, "delivery_machine": "aico"}
    state = sample(cfg, {}, 90, 100, [], starting=True)
    hot = guard.notice_payload(cfg, snapshot(cfg), 100)
    assert hot["phase"] == "critical" and hot["temperature_c"] == 90
    assert hot["episode_id"] == state["episode"]["id"]
    stale = guard.notice_payload(cfg, snapshot(cfg), 200)
    assert stale["episode_id"] == hot["episode_id"] and stale["phase"] == "unavailable"
    assert stale["temperature_c"] is None
    sample(cfg, state, 80, 115, [])
    recovered = guard.notice_payload(cfg, snapshot(cfg), 115)
    assert recovered["phase"] == "recovered" and recovered["admission_open"]
    assert recovered["episode_id"] == hot["episode_id"]


def test_guard_episode_uses_existing_validated_local_thermal_row(cfg, tmp_path, monkeypatch):
    from pve_sender import watch

    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps(cfg))
    monkeypatch.setattr(guard, "DEFAULT_CONFIG", policy)
    monkeypatch.setattr(watch.core, "run_command", lambda *_a, **_k: watch.core.Result(
        0, "===NS hwmon\nT k10temp Tctl 92000 0 0\n===NS end\n", ""
    ))
    state = sample(cfg, {}, 92, 100, [], starting=True)
    checks = {}
    rows = watch.local_rows(checks, 100, "davion-gem")
    row = next(item for item in rows if item["id"] == "davion-gem/check-thermal")
    assert row["guard"] == {
        "episode_id": state["episode"]["id"], "phase": "critical", "temperature_c": 92,
        "cpu_quota_percent": 10, "admission_open": False, "delivery_machine": "aico",
    }
    assert checks["push_failed"][row["id"]] is False
    Path(cfg["runtime_dir"], "status.json").unlink()
    missing_state = {}
    missing = next(item for item in watch.local_rows(missing_state, 101, "davion-gem")
                   if item["id"] == row["id"])
    assert missing["guard"]["phase"] == "unavailable"
    assert missing["guard"]["temperature_c"] is None
    sample(cfg, {}, 60, 102, [], starting=True)
    restored = next(item for item in watch.local_rows(missing_state, 102, "davion-gem")
                    if item["id"] == row["id"])
    assert restored["guard"]["phase"] == "recovered"
    assert restored["guard"]["episode_id"] == missing["guard"]["episode_id"]
    quiet = next(item for item in watch.local_rows(missing_state, 103, "davion-gem")
                 if item["id"] == row["id"])
    assert "guard" not in quiet


def test_cli_budget_and_deferred_export(cfg, tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(guard.os, "geteuid", lambda: 0)
    path = tmp_path / "policy.json"
    path.write_text(json.dumps(cfg))
    assert guard.main(["--config", str(path), "budget"]) == 0
    assert json.loads(capsys.readouterr().out)["admit"] is False
    assert guard.main(["--config", str(path), "run", "--", "export"]) == 75
    assert "fresh local temperature" in capsys.readouterr().err


def test_unit_keeps_guard_lightweight_and_runtime_heartbeat_through_restart():
    unit = (ROOT / "native/pve-sender/systemd/aico-backup-guard.service").read_text()
    assert "RuntimeDirectoryPreserve=yes" in unit
    assert "aico-backup-guard daemon" in unit
    assert "ExecStop" not in unit
    assert "OnFailure" not in unit
