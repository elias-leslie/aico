"""Synthetic local sensors and stubbed cgroups: no heat, network or live exports."""
from __future__ import annotations

import fcntl
import json
import os
import sys
import threading
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
                 hwmon_root=str(tmp_path / "hwmon"), boot_id_path=str(tmp_path / "boot-id"),
                 sender_config=str(ROOT / "native/pve-sender/config.json"))
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


def test_only_public_runtime_telemetry_is_readable_to_local_admission(cfg):
    old_umask = os.umask(0o077)
    try:
        sample(cfg, {}, 60, 100, [], starting=True)
    finally:
        os.umask(old_umask)
    status = Path(cfg["runtime_dir"]) / "status.json"
    saved = Path(cfg["state_dir"]) / "state.json"
    assert status.stat().st_mode & 0o777 == 0o644
    assert saved.stat().st_mode & 0o777 == 0o600
    assert "events" not in json.loads(status.read_text())
    assert "event_seq" not in json.loads(status.read_text())
    assert "sender_config" not in json.loads(status.read_text())
    assert "sender_config" not in json.loads(status.read_text())["policy"]


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
    assert len(state["episode"]["id"]) == 32
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


def test_notice_payload_keeps_one_identity_from_fallback_sensor_outage_through_heat_recovery(cfg):
    unavailable = guard.notice_payload(cfg, {}, 100)
    assert unavailable == {"episode_id": unavailable["episode_id"], "phase": "unavailable",
                           "temperature_c": None, "cpu_quota_percent": 50,
                           "admission_open": False, "delivery_machine": "aico"}
    state = sample(cfg, {}, 90, 100, [], starting=True)
    hot = guard.notice_payload(cfg, snapshot(cfg), 100)
    assert hot["phase"] == "critical" and hot["temperature_c"] == 90
    assert hot["episode_id"] == unavailable["episode_id"]
    stale = guard.notice_payload(cfg, snapshot(cfg), 200)
    assert stale["episode_id"] == hot["episode_id"] and stale["phase"] == "unavailable"
    assert stale["temperature_c"] is None
    sample(cfg, state, 80, 115, [])
    recovered = guard.notice_payload(cfg, snapshot(cfg), 115)
    assert recovered["phase"] == "recovered" and recovered["admission_open"]
    assert recovered["episode_id"] == hot["episode_id"]


def test_guard_episode_uses_shared_validated_guard_row(cfg, tmp_path, monkeypatch):
    from pve_sender import watch

    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps(cfg))
    monkeypatch.setattr(guard, "DEFAULT_CONFIG", policy)
    monkeypatch.setattr(guard, "publish_row", lambda *_: True)
    monkeypatch.setattr(watch.core, "run_command", lambda *_a, **_k: watch.core.Result(
        0, "===NS hwmon\nT k10temp Tctl 92000 0 0\n===NS end\n", ""
    ))
    state = sample(cfg, {}, 92, 100, [], starting=True)
    checks = {}
    rows = watch.local_rows(checks, 100, "davion-gem")
    row = checks["guard_row"]
    assert not any(guard.owns_row(item) for item in rows)
    assert row["guard"] == {
        "episode_id": state["episode"]["id"], "phase": "critical", "temperature_c": 92,
        "cpu_quota_percent": 10, "admission_open": False, "delivery_machine": "aico",
    }
    assert checks["push_failed"][row["id"]] is False
    Path(cfg["runtime_dir"], "status.json").unlink()
    missing_state = {}
    watch.local_rows(missing_state, 101, "davion-gem")
    missing = missing_state["guard_row"]
    assert missing["guard"]["phase"] == "unavailable"
    assert missing["guard"]["temperature_c"] is None
    sample(cfg, {}, 60, 102, [], starting=True)
    watch.local_rows(missing_state, 102, "davion-gem")
    restored = missing_state["guard_row"]
    assert restored["guard"]["phase"] == "recovered"
    assert restored["guard"]["episode_id"] == missing["guard"]["episode_id"]
    watch.local_rows(missing_state, 103, "davion-gem")
    quiet = missing_state["guard_row"]
    assert "guard" not in quiet


def test_new_sensor_outages_get_unique_persisted_ids_on_same_boot_then_heat(cfg):
    first = sample(cfg, {}, None, 100, [], starting=True)
    first_payload = guard.notice_payload(cfg, snapshot(cfg), 100)
    recovered = sample(cfg, first, 60, 115, [])
    guard.notice_payload(cfg, snapshot(cfg), 115)
    reopened = sample(cfg, recovered, None, 130, [])
    assert reopened["episode"]["id"] != first["episode"]["id"]
    second_payload = guard.notice_payload(cfg, snapshot(cfg), 130)
    assert second_payload["episode_id"] != first_payload["episode_id"]
    saved = guard.load(Path(cfg["state_dir"]) / "state.json")
    restarted = sample(cfg, saved, None, 145, [], starting=True)
    assert restarted["episode"]["id"] == reopened["episode"]["id"]
    heated = sample(cfg, restarted, 90, 160, [])
    assert heated["episode"]["id"] == reopened["episode"]["id"]
    assert guard.notice_payload(cfg, snapshot(cfg), 160)["episode_id"] == second_payload["episode_id"]


def test_stale_fallback_after_recovery_opens_unique_id_and_recovers_after_restart(cfg):
    state = sample(cfg, {}, 90, 100, [], starting=True)
    first = guard.notice_payload(cfg, snapshot(cfg), 100)
    sample(cfg, state, 60, 115, [])
    recovered_snapshot = snapshot(cfg)
    guard.notice_payload(cfg, recovered_snapshot, 115)
    stale = guard.notice_payload(cfg, recovered_snapshot, 200)
    assert stale["episode_id"] != first["episode_id"]
    assert guard.notice_payload(dict(cfg), recovered_snapshot, 215)["episode_id"] == stale["episode_id"]
    # The daemon resumes with the old recovered episode, without reopening that old ID.
    resumed = {**recovered_snapshot, "observed_at": 220}
    recovered = guard.notice_payload(dict(cfg), resumed, 220)
    assert recovered["phase"] == "recovered" and recovered["episode_id"] == stale["episode_id"]
    again = guard.notice_payload(dict(cfg), resumed, 300)
    assert again["episode_id"] not in (first["episode_id"], stale["episode_id"])


def test_brief_critical_and_recovery_each_publish_without_waiting_for_periodic_watch(cfg):
    import aico_status

    events, quotas = [], []
    state = sample(cfg, {}, 60, 100, quotas, starting=True)
    for now, temperature in ((115, 90), (130, 89), (145, 60), (160, 65)):
        state = sample(cfg, state, temperature, now, quotas, publish=events.append)
    assert all(isinstance(event, str) for event in events)
    assert not Path(cfg["state_dir"], "notice.lock").exists()
    snapshots = [json.loads(event)["snapshot"] for event in events]
    rows = [guard.status_row(cfg, value, value["observed_at"], historical=True) for value in snapshots]
    assert [row["guard"]["phase"] for row in rows] == ["critical", "recovered"]
    assert rows[0]["guard"]["episode_id"] == rows[1]["guard"]["episode_id"]
    assert quotas == ["normal", "critical", "normal"]
    assert all(aico_status.check_row(row) == row for row in rows)


def test_slow_publisher_never_blocks_enforcement_or_drops_next_phase(cfg):
    entered, release = threading.Event(), threading.Event()
    attempted = []

    def post(_cfg, row):
        attempted.append(row["guard"]["phase"])
        if row["guard"]["phase"] == "critical":
            entered.set()
            assert release.wait(2)
        return True

    publisher = guard.Publisher(cfg, publish=post)
    try:
        quotas = []
        state = sample(cfg, {}, 60, 100, quotas, starting=True)
        state = sample(cfg, state, 90, 115, quotas, publish=publisher)
        assert entered.wait(2)
        # First post is still blocked while the local loop restores the CPU ceiling.
        sample(cfg, state, 60, 130, quotas, publish=publisher)
        assert quotas == ["normal", "critical", "normal"]
        assert snapshot(cfg)["admission_open"]
        release.set()
        publisher.items.join()
        assert attempted == ["critical", "recovered"]
    finally:
        release.set()
        publisher.items.put(None)
        publisher.thread.join(2)


def test_publish_reuses_only_existing_status_command(cfg):
    events = []
    state = sample(cfg, {}, 90, 100, [], starting=True, publish=events.append)
    value = json.loads(events[0])["snapshot"]
    rows = [guard.status_row(cfg, value, value["observed_at"], historical=True)]
    calls = []

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        return SimpleNamespace(returncode=0)

    assert state["mode"] == "critical"
    assert guard.publish_row(cfg, rows[0], run=run)
    assert calls[0][0] == json.loads(Path(cfg["sender_config"]).read_text())["status_command"]
    assert json.loads(calls[0][1]["input"]) == rows


def test_old_config_defaults_preserve_owner_limits(cfg, tmp_path):
    old = {key: value for key, value in cfg.items() if key not in ("machine", "sender_config")}
    old["hot_cpu_percent"] = 17
    path = tmp_path / "backup-guard.json"
    path.write_text(json.dumps(old))
    loaded = guard.config(path)
    assert loaded["hot_cpu_percent"] == 17
    assert loaded["machine"] and loaded["sender_config"] == str(tmp_path / "pve-sender.json")
    assert json.loads(path.read_text()) == old


def test_old_active_state_gets_one_durable_phase_on_first_upgraded_start(cfg):
    legacy = {"mode": "critical", "limit_mode": "critical",
              "episode": {"id": "legacy-incident", "started_at": 90, "peak_mode": "critical"}}
    events = []
    state = sample(cfg, legacy, 90, 100, [], starting=True, publish=events.append)
    assert len(events) == 1 and json.loads(events[0])["snapshot"]["mode"] == "critical"
    sample(cfg, guard.persistent(state), 90, 115, [], starting=True, publish=events.append)
    assert len(events) == 1


def test_held_notice_lock_cannot_stall_later_temperature_and_quota_tick(cfg, monkeypatch):
    state = sample(cfg, {}, 60, 100, [], starting=True)
    entered, finished = threading.Event(), threading.Event()
    original = guard.status_row

    def blocked(*args, **kwargs):
        entered.set()
        return original(*args, **kwargs)

    monkeypatch.setattr(guard, "status_row", blocked)
    publisher = guard.Publisher(cfg, publish=lambda *_: True)
    publisher.items.join()
    quotas = []
    with Path(cfg["state_dir"], "notice.lock").open("a") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        try:
            def recover():
                hot = sample(cfg, state, 90, 115, quotas, publish=publisher)
                sample(cfg, hot, 60, 130, quotas, publish=publisher)
                finished.set()

            loop = threading.Thread(target=recover)
            loop.start()
            assert entered.wait(2)
            assert finished.wait(2), "Notice bookkeeping stalled the quota loop."
            assert quotas == ["critical", "normal"]
            assert snapshot(cfg)["admission_open"]
        finally:
            fcntl.flock(held, fcntl.LOCK_UN)
            publisher.items.put(None)
    loop.join(2)
    publisher.thread.join(2)


def test_failed_critical_head_survives_recovery_restart_and_ack_prevents_duplicate_replay(cfg):
    state = sample(cfg, {}, 90, 100, [], starting=True)
    attempted = []

    def offline(_cfg, row):
        attempted.append(row["guard"]["phase"])
        return False

    with pytest.raises(OSError):
        guard.deliver_pending(cfg, publish=offline)
    sample(cfg, state, 60, 115, [])
    with pytest.raises(OSError):
        guard.deliver_pending(cfg, publish=offline)
    assert attempted == ["critical", "critical"]
    delivery = guard.load(Path(cfg["state_dir"], "delivery.json"))
    assert [event["row"]["guard"]["phase"] for event in delivery["pending"]] == ["critical", "recovered"]
    # A fresh publisher only has files; its in-memory queue and mode history are gone.
    Path(cfg["boot_id_path"]).write_text("next-boot")
    replayed = []
    publisher = guard.Publisher(dict(cfg), publish=lambda _cfg, row: replayed.append(row["guard"]["phase"]) or True)
    publisher.items.join()
    publisher.items.put(None)
    publisher.thread.join(2)
    assert replayed == ["critical", "recovered"]
    assert guard.deliver_pending(dict(cfg), publish=lambda *_: pytest.fail("ACKed phase replayed.")) == 2
    assert Path(cfg["state_dir"], "delivery.json").stat().st_mode & 0o777 == 0o600


def test_periodic_reconcile_retains_failed_head_then_retries_phases_in_order(cfg, monkeypatch):
    state = sample(cfg, {}, 90, 100, [], starting=True)
    sample(cfg, state, 60, 115, [])
    monkeypatch.setattr(guard, "publish_row", lambda *_: False)
    failed = guard.reconcile_row(cfg, "davion-gem", clock=lambda: 115)
    assert failed["guard"]["phase"] == "critical"
    posted = []
    monkeypatch.setattr(guard, "publish_row", lambda _cfg, row: posted.append(row["guard"]["phase"]) or True)
    reconciled = guard.reconcile_row(cfg, "davion-gem", clock=lambda: 115)
    assert posted == ["critical", "recovered", "recovered"]
    assert reconciled["guard"]["phase"] == "recovered"


@pytest.mark.parametrize("cached", [False, True])
def test_watchdog_generic_batch_cannot_repost_old_guard_after_publisher_recovery(cfg, tmp_path, monkeypatch, cached):
    from pve_sender import watch, watchdog
    from pve_sender.state import write

    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps(cfg))
    monkeypatch.setattr(guard, "DEFAULT_CONFIG", policy)
    monkeypatch.setattr(guard, "publish_row", lambda *_: False)
    monkeypatch.setattr(watch.core, "run_command", lambda *_a, **_k: watch.core.Result(
        0, "===NS hwmon\nT k10temp Tctl 95000 0 0\n===NS end\n", ""
    ))
    hot_state = sample(cfg, {}, 95, 1000, [], starting=True)
    sender_cfg = json.loads((ROOT / "native/pve-sender/config.json").read_text())
    sender_cfg["state_dir"] = str(tmp_path / "sender")
    directory = Path(sender_cfg["state_dir"])
    write(directory / "heartbeats.json", {"workstation": {"at": 1000}, "ct190": {"at": 1000}})
    old = guard.reconcile_row(cfg, "davion-gem", clock=lambda: 1000)
    write(directory / "state.json", {"started": 1000, "local_rows": [old] if cached else []})
    store = {}
    applied = []

    def accepted(_cfg, row):
        store[row["id"]] = row
        applied.append(row["guard"]["phase"])
        return True

    def local(checks, now, machine):
        if cached:
            raise OSError("periodic probe failed; use saved evidence")
        rows = watch.local_rows(checks, now, machine)
        assert checks["guard_row"]["guard"]["phase"] == "critical"
        return rows

    def door(_alias):
        # The watchdog has collected critical evidence and now does another probe.
        # Meanwhile the independent publisher successfully catches up through recovery.
        sample(cfg, hot_state, 60, 1015, [])
        guard.deliver_pending(cfg, publish=accepted)

    batches = []

    def generic_post(_argv, **kwargs):
        batch = json.loads(kwargs["input"])
        batches.append(batch)
        for row in batch:
            # Match StatusStore.upsert: an older row unconditionally replaces the current row.
            store[row["id"]] = row
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(watchdog.subprocess, "run", generic_post)
    result = watchdog.tick(sender_cfg, now=1000, boot=0, local=local, door=door,
                           send=lambda _: pytest.fail("No phone send belongs to this test."))
    assert result["rows_posted"]
    assert applied == ["critical", "recovered"]
    assert not any(guard.owns_row(row) for batch in batches for row in batch)
    assert store[old["id"]]["guard"]["phase"] == "recovered"


@pytest.mark.parametrize("recover", [False, True])
def test_periodic_reconcile_cannot_publish_runtime_snapshot_older_than_accepted_phase(cfg, recover):
    from pve_sender.state import write

    state = sample(cfg, {}, 60, 100, [], starting=True)
    old = snapshot(cfg)
    state = sample(cfg, state, 90, 115, [])
    if recover:
        old = snapshot(cfg)
        sample(cfg, state, 60, 130, [])
    # A write window or cached file presents an older snapshot than the durable phase log.
    write(Path(cfg["runtime_dir"]) / "status.json", old, mode=0o644)
    posted = []
    result = guard.reconcile_row(cfg, "davion-gem", clock=lambda: 135,
                                 publish=lambda _cfg, row: posted.append(row["guard"]["phase"]) or True)
    assert posted == (["critical", "recovered"] if recover else ["critical"])
    expected = "recovered" if recover else "critical"
    assert result["guard"]["phase"] == expected
    assert guard.load(Path(cfg["state_dir"]) / "notice.json")["phase"] == expected


def test_fresh_cpu_guard_owns_cpu_notice_while_other_hot_sensors_and_cpu_fallback_remain(cfg, tmp_path, monkeypatch):
    from pve_sender import watch

    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps(cfg))
    monkeypatch.setattr(guard, "DEFAULT_CONFIG", policy)
    monkeypatch.setattr(guard, "publish_row", lambda *_: True)
    sensors = "T k10temp Tctl 95000 0 0\n"
    monkeypatch.setattr(watch.core, "run_command", lambda *_a, **_k: watch.core.Result(
        0, "===NS hwmon\n" + sensors + "===NS end\n", ""
    ))
    sample(cfg, {}, 95, 100, [], starting=True)
    checks = {}
    rows = watch.local_rows(checks, 100, "davion-gem")
    failed = [row for row in rows if row["state"] == "failed" and "temperature" in row["what"].lower()]
    assert failed == []
    dedicated = checks["guard_row"]
    assert dedicated["state"] == "failed" and dedicated["guard"]["phase"] == "critical"
    sensors += "T nvme Composite 85000 70000 80000\n"
    other = next(row for row in watch.local_rows({}, 100, "davion-gem") if row["id"].endswith("/check-thermal"))
    assert other["state"] == "failed" and "NVMe 85C" in other["meaning"]
    assert "CPU" not in other["meaning"]
    sensors = "T k10temp Tctl 95000 0 0\n"
    stale = next(row for row in watch.local_rows({}, 200, "davion-gem") if row["id"].endswith("/check-thermal"))
    assert stale["state"] == "failed" and "CPU 95C" in stale["meaning"]


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
