"""Off-host alarm decisions and guest sends; no keys, network, or real host actions."""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import aico_status

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pve-sender"))
from pve_sender import push, sender, trim, watchdog
from pve_sender.state import read, write

ROOT = Path(__file__).resolve().parents[3]


def test_weekly_trim_only_visits_running_containers_and_reports_failures(cfg):
    calls = []
    def run(argv):
        calls.append(argv)
        if argv == ["pct", "list"]:
            return SimpleNamespace(returncode=0, stdout="VMID Status Lock Name\n150 running hub\n160 stopped backup\n190 running aico\n", stderr="")
        return SimpleNamespace(returncode=1 if argv[-1] == "190" else 0, stdout="", stderr="")
    result = trim.run(cfg, run=run, now=1000)
    assert calls == [["pct", "list"], ["pct", "fstrim", "150"], ["pct", "fstrim", "190"]]
    assert result["state"] == "failed"
    assert result["trimmed"] == ["150"]
    assert result["failed"] == ["190"]
    assert trim.status_row(cfg, 1001)["state"] == "failed"


def test_pve_sender_keeps_its_local_ecc_row_when_workstation_publication_is_retired(monkeypatch):
    from pve_sender import watch

    assert watch.core.load_data()["checks"]["ecc"]["run_on_host"] is False
    monkeypatch.setattr(watch.core, "run_command", lambda *_a, **_k: watch.core.Result(
        0, "===NS ecc\nFIRST 100\n===NS end\n", ""
    ))
    rows = watch.local_rows({}, 1000, "davion-gem")
    row = next(row for row in rows if row["id"] == "davion-gem/check-ecc")
    assert row["what"] == "PVE memory errors"


@pytest.fixture
def cfg(tmp_path):
    data = json.loads((ROOT / "native/pve-sender/config.json").read_text())
    data["state_dir"] = str(tmp_path)
    data["credentials"] = str(tmp_path / "creds.json")
    data["token_cache"] = str(tmp_path / "token.json")
    data["window_s"] = 60
    write(tmp_path / "state.json", {"started": 100})
    return data


def beats(cfg, ws=100, ct=100, **more):
    data = {"workstation": {"at": ws}, "ct190": {"at": ct}}
    data.update(more)
    write(Path(cfg["state_dir"]) / "heartbeats.json", data)


def ticking(cfg, notices, now, ok=True):
    def send(notice):
        notices.append(notice)
        return {"ok": ok, "result": "Test transport accepted."}
    return watchdog.tick(cfg, now=now, boot=0, send=send, test=True, publish=False)


@pytest.mark.parametrize("ws,ct,now,silent", [
    (100, 100, 160, False), (100, 100, 161, True),
    (100, 159, 200, False), (199, 100, 200, False),
])
def test_both_heartbeats_must_pass_the_window(cfg, ws, ct, now, silent):
    beats(cfg, ws, ct)
    status = ticking(cfg, [], now)
    assert status["silent"] is silent


def test_one_alarm_across_repeated_ticks_and_process_restarts_then_recovery(cfg):
    beats(cfg)
    notices = []
    ticking(cfg, notices, 161)
    ticking(cfg, notices, 170)
    ticking(cfg, notices, 200)
    assert len(notices) == 1
    assert notices[0]["title"].startswith("TEST (ignore):")
    beats(cfg, ct=201)
    ticking(cfg, notices, 201)
    ticking(cfg, notices, 202)
    assert len(notices) == 2
    assert notices[1]["severity"] == "ok"
    assert not read(Path(cfg["state_dir"]) / "state.json")["alarms"]
    beats(cfg, ct=201)
    ticking(cfg, notices, 262)
    assert len(notices) == 3  # a new outage is a new event


def test_rejected_send_retries_and_only_acceptance_deduplicates(cfg):
    beats(cfg)
    notices = []
    ticking(cfg, notices, 161, ok=False)
    assert not read(Path(cfg["state_dir"]) / "state.json")["alarms"]
    ticking(cfg, notices, 162)
    ticking(cfg, notices, 163)
    assert len(notices) == 2


def test_pve_reboot_does_not_count_its_own_downtime(cfg):
    beats(cfg)
    state = {"started": 100}
    current = read(Path(cfg["state_dir"]) / "heartbeats.json")
    assert watchdog.decision(current, state, cfg, 1000, 990)[0] is False
    assert watchdog.decision(current, state, cfg, 1051, 990)[0] is True


@pytest.mark.parametrize("value", [None, "123", True, math.inf, math.nan, 1001])
def test_bad_or_future_stamp_is_unknown(value):
    assert watchdog.age(value, 1000, 0, 100) is None


def test_absent_sources_get_one_startup_window(cfg):
    state = {}
    assert watchdog.decision({}, state, cfg, 1000, 0)[0] is False
    assert watchdog.decision({}, state, cfg, 1060, 0)[0] is False
    assert watchdog.decision({}, state, cfg, 1061, 0)[0] is True


def test_floor_alarm_does_not_require_both_sources_down(cfg):
    beats(cfg, ws=150, ct=150, workstation={"at": 150, "floor_failed": True})
    notices = []
    ticking(cfg, notices, 151)
    ticking(cfg, notices, 152)
    assert len(notices) == 1
    assert notices[0]["key"] == "pve-sender:floor:workstation"
    beats(cfg, ws=153, ct=153)
    ticking(cfg, notices, 154)
    assert len(notices) == 2
    assert notices[1]["severity"] == "ok"


def test_stale_failed_floor_does_not_claim_recovery(cfg):
    beats(cfg, ws=150, ct=150, workstation={"at": 150, "floor_failed": True})
    notices = []
    ticking(cfg, notices, 151)
    beats(cfg, ws=150, ct=220, workstation={"at": 150, "floor_failed": True})
    ticking(cfg, notices, 221)
    assert len(notices) == 1
    beats(cfg, ws=222, ct=222)
    ticking(cfg, notices, 223)
    assert len(notices) == 2 and notices[-1]["severity"] == "ok"


def test_sender_does_not_repeat_successful_recipient_after_partial_failure(cfg, monkeypatch):
    write(Path(cfg["credentials"]), {"fcm": {"service_account": {"project_id": "fixture", "private_key_id": "fixture"},
          "devices": [{"fcm_token": "good"}, {"fcm_token": "retry"}]}})
    write(Path(cfg["token_cache"]), {"access_token": "fixture", "key_id": "fixture", "expires_at": 9999})
    called = []
    def transport(dev, *_a):
        called.append(dev["fcm_token"])
        return 200 if dev["fcm_token"] == "good" or called.count("retry") > 1 else 503
    monkeypatch.setattr(sender.fcm, "fcm_push", transport)
    message = notice(delivery_id="event-1")
    assert not sender.send(cfg, message, now=100)["ok"]
    assert sender.send(cfg, message, now=101)["ok"]
    assert called == ["good", "retry", "retry"]


def test_permanent_rejection_does_not_resend_to_healthy_phone(cfg, monkeypatch):
    write(Path(cfg["credentials"]), {"fcm": {"service_account": {"project_id": "fixture", "private_key_id": "fixture"},
          "devices": [{"fcm_token": "good"}, {"fcm_token": "gone"}]}})
    write(Path(cfg["token_cache"]), {"access_token": "fixture", "key_id": "fixture", "expires_at": 9999})
    called = []
    def transport(dev, *_a):
        called.append(dev["fcm_token"])
        return 200 if dev["fcm_token"] == "good" else 404
    monkeypatch.setattr(sender.fcm, "fcm_push", transport)
    for now in [100, 101]:
        sender.send(cfg, notice(delivery_id="event-1"), now=now)
    assert called == ["good", "gone"]


def test_shutdown_ws_does_not_trigger_failed_rescue_login(cfg):
    beats(cfg, ws=100, ct=2000)
    notices = []
    def send(item):
        notices.append(item)
        return {"ok": True}
    for now in [2000, 2001]:
        watchdog.tick(cfg, now=now, boot=0, send=send, local=lambda *_a: [],
                      door=lambda *_a: "offline", publish=False)
    assert notices == []


def test_door_probe_suppresses_unreachable_workstation(cfg, monkeypatch):
    from pve_sender import watch
    replies = iter([SimpleNamespace(returncode=0, stdout="hostname resolved.fixture\n"),
                    SimpleNamespace(returncode=255, stdout=""),
                    SimpleNamespace(returncode=1, stdout="")])
    monkeypatch.setattr(watch.subprocess, "run", lambda *_a, **_k: next(replies))
    assert watch.door_probe("fixture", "fixture") == "offline"


def test_open_outage_stays_open_across_pve_reboot(cfg):
    beats(cfg)
    notices = []
    def send(item):
        notices.append(item)
        return {"ok": True}
    for now, boot in [(161, 0), (162, 162), (223, 162)]:
        watchdog.tick(cfg, now=now, boot=boot, send=send, test=True, publish=False)
    assert len(notices) == 1
    beats(cfg, ct=224)
    watchdog.tick(cfg, now=224, boot=162, send=send, test=True, publish=False)
    assert len(notices) == 2 and notices[-1]["severity"] == "ok"


def test_local_check_health_row_recovers(cfg):
    beats(cfg, ws=150, ct=150)
    def fail(*_a):
        raise OSError("fixture")
    first = watchdog.tick(cfg, now=151, boot=0, local=fail, door=lambda *_a: None, publish=False)
    second = watchdog.tick(cfg, now=152, boot=0, local=lambda *_a: [], door=lambda *_a: None, publish=False)
    failed = next(r for r in first["rows"] if r["id"].endswith("/pve-watch"))
    assert failed["state"] == "failed"
    recovered = next(r for r in second["rows"] if r["id"] == failed["id"])
    assert recovered["state"] == "ok"


def test_status_rows_follow_the_shared_contract(cfg):
    # Replay the shared vectors as well as validate every row we produce.
    fixtures = json.loads((ROOT / "contracts/status-row-fixtures.json").read_text())
    for valid in fixtures["valid"]:
        assert aico_status.check_row(valid["row"])
    for invalid in fixtures["invalid"]:
        with pytest.raises(aico_status.RowError):
            aico_status.check_row(invalid["row"])
    beats(cfg, ws=150, ct=150)
    status = ticking(cfg, [], 151)
    assert any(row["kind"] == "machine" for row in status["rows"])
    for row in status["rows"]:
        assert aico_status.check_row(row) == row


def notice(**changes):
    return {"v": 1, "source": "aico", "kind": "info", "severity": "info",
            "title": "Test", "body": "A test notice.", "key": "test:one", **changes}


def test_existing_aico_and_portfolio_contracts(cfg):
    aico = cfg["callers"]["aico"]
    assert push.validate(json.dumps(notice(open="https://aico.summitflow.dev/")), aico)
    port = {"v": 1, "source": "portfolio-ai", "kind": "alert", "severity": "critical",
            "title": "Test", "body": "Test", "key": "portfolio-ai:test", "open": "https://port.summitflow.dev/status#one"}
    assert push.validate(json.dumps(port), cfg["callers"]["portfolio"])
    for bad in [notice(open="https://aico.summitflow.dev.evil/"), notice(severity="critical"),
                notice(key="test:one\n"), notice(title="\n"), notice(open="https://user@aico.summitflow.dev/")]:
        with pytest.raises(ValueError):
            push.validate(json.dumps(bad), aico)


def test_guest_dedupe_survives_restart_and_heartbeat_is_scoped(cfg):
    sent = []
    def send(item):
        sent.append(item)
        return {"ok": True}
    push.push(cfg, "aico", json.dumps(notice()), now=100, send=send)
    push.push(cfg, "aico", json.dumps(notice()), now=200, send=send)
    assert len(sent) == 1
    answer = push.push(cfg, "aico", json.dumps({"v": 1, "source": "aico", "kind": "heartbeat"}), now=300, send=send)
    assert answer["heartbeat"] == "ct190"
    data = read(Path(cfg["state_dir"]) / "heartbeats.json")
    assert set(data) == {"ct190"}
    assert len(sent) == 1
    with pytest.raises(ValueError):
        push.push(cfg, "portfolio", json.dumps({"v": 1, "source": "aico", "kind": "heartbeat"}), now=300, send=send)


def test_fcm_route_uses_existing_cache_and_app_protocol(cfg, monkeypatch):
    write(Path(cfg["credentials"]), {"fcm": {"service_account": {"project_id": "fixture", "private_key_id": "fixture"},
          "base": "https://aico.example.dev", "devices": [{"fcm_token": "fixture", "enc_pub": "fixture", "auth": "fixture"}]}})
    write(Path(cfg["token_cache"]), {"access_token": "fixture", "key_id": "fixture", "expires_at": 9999})
    captured = []
    def send(_dev, plain, _severity, _project, _token):
        captured.append(json.loads(plain))
        return 200
    monkeypatch.setattr(sender.fcm, "fcm_push", send)
    result = sender.send(cfg, notice(), now=100)
    assert result["ok"] and result["accepted"] == 1
    assert captured[0]["v"] == 1
    assert captured[0]["channel"] == "info"
    assert captured[0]["tag"] == "test:one"
    assert captured[0]["actions"] == []


def test_no_credentials_are_failure_and_exceptions_do_not_echo_secrets(cfg, monkeypatch, capsys):
    assert not sender.send(cfg, notice(), now=100)["ok"]
    write(Path(cfg["credentials"]), {"fcm": {"service_account": {"project_id": "fixture"}, "devices": [{"fcm_token": "fixture"}]}})
    def broken(*_args):
        raise ValueError("fixture-secret-do-not-print")
    monkeypatch.setattr(sender.fcm, "mint", broken)
    result = sender.send(cfg, notice(), now=100)
    assert "fixture-secret" not in json.dumps(result)
    assert not capsys.readouterr().out


def test_host_heartbeat_fails_if_watchdog_stopped(cfg, monkeypatch):
    import io

    from host_steward import heartbeat
    config = json.loads((ROOT / "native/host-steward/host_steward/data/heartbeat.json").read_text())
    monkeypatch.setattr(heartbeat.OPENER, "open", lambda *_a, **_k: io.StringIO('{"rows":[]}'))
    rows = []
    def execute(*_a, **_k):
        return SimpleNamespace(returncode=0, stdout=json.dumps({"heartbeat": "workstation", "sender_age": 900, "rows": []}))
    assert heartbeat.run(config, execute=execute, post=lambda values, **_k: rows.extend(values)) == 1
    assert rows[-1]["state"] == "failed"


def test_ct_heartbeat_requires_live_app(cfg, monkeypatch):
    from host_steward import heartbeat
    config = json.loads((ROOT / "native/host-steward/host_steward/data/heartbeat.json").read_text())
    config["source"] = "ct190"
    def fail(*_a, **_k):
        raise OSError("offline")
    monkeypatch.setattr(heartbeat.OPENER, "open", fail)
    def execute(*_a, **_k):
        pytest.fail("A stopped CT app must not refresh its heartbeat")
    assert heartbeat.run(config, execute=execute) == 1


def test_portfolio_can_send_again_after_its_window(cfg, monkeypatch):
    write(Path(cfg["credentials"]), {"fcm": {"service_account": {"project_id": "fixture", "private_key_id": "fixture"},
          "devices": [{"fcm_token": "good"}]}})
    write(Path(cfg["token_cache"]), {"access_token": "fixture", "key_id": "fixture", "expires_at": 999999})
    calls = []
    def transport(*_args):
        calls.append(1)
        return 200
    monkeypatch.setattr(sender.fcm, "fcm_push", transport)
    text = json.dumps(notice(source="portfolio-ai", kind="alert", key="portfolio-ai:repeat"))
    assert push.push(cfg, "portfolio", text, now=100)["ok"]
    assert push.push(cfg, "portfolio", text, now=90100)["ok"]
    assert len(calls) == 2


def test_installer_copies_only_and_preserves_config(tmp_path):
    config = tmp_path / "config" / "sender.json"
    config.parent.mkdir()
    config.write_text('{"operator_setting":true}')
    env = {**os.environ, "PATH": "/usr/bin:/bin", "PVE_SENDER_PREFIX": str(tmp_path / "lib"),
           "PVE_SENDER_UNITS": str(tmp_path / "units"), "PVE_SENDER_SBIN": str(tmp_path / "sbin"),
           "PVE_SENDER_CONFIG": str(config), "PVE_SENDER_STEWARD": str(tmp_path / "steward"),
           "PVE_SENDER_NO_SYSTEMCTL": "1"}
    done = subprocess.run(["bash", str(ROOT / "native/pve-sender/install.sh")], env=env, check=False, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    assert json.loads(config.read_text()) == {"operator_setting": True}
    assert (tmp_path / "units/aico-pve-sender.timer").is_file()
    assert (tmp_path / "sbin/pve-sender").resolve() == tmp_path / "lib/pve-sender"
    assert not (tmp_path / "sbin/aico-push").exists()  # live wrapper switch needs the runtime preflight


def test_ct_installer_uses_existing_push_key_and_correct_machine_id(tmp_path):
    env = {**os.environ, "PATH": "/usr/bin:/bin", "CT_HEARTBEAT_PREFIX": str(tmp_path / "steward"),
           "CT_HEARTBEAT_UNITS": str(tmp_path / "units"), "CT_HEARTBEAT_NO_SYSTEMCTL": "1"}
    done = subprocess.run(["bash", str(ROOT / "native/pve-sender/install-ct190.sh")], env=env, check=False, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    data = json.loads((tmp_path / "steward/host_steward/data/heartbeat.json").read_text())
    assert data["source"] == "ct190" and data["ssh"][-1] == "pve-alerts"
    assert data["floor_ids"] == ["aico/notify-outbox"]
    assert "User=kasadis" in (tmp_path / "units/host-steward-heartbeat.service").read_text()


def test_host_token_mint_preserves_contract_and_permissions(tmp_path, monkeypatch, capsys):
    from host_steward import fcm_token
    account = tmp_path / "account.json"
    token = tmp_path / "cache/token.json"
    account.write_text('{"project_id":"fixture"}')
    cfg = {"account": str(account), "token": str(token), "owner": "kasadis", "refresh_before_s": 2400,
           "every_s": 1200, "slack_s": 300}
    monkeypatch.setattr(fcm_token.os, "chown", lambda *_a: None)
    rows, calls = [], []
    def mint(_sa, now):
        calls.append(now)
        return "fixture-secret-token", now + 3600
    assert fcm_token.refresh(cfg, now=100, mint=mint, post=rows.append) == 0
    saved = read(token)
    assert saved["expires_at"] == 3700 and saved["project_id"] == "fixture"
    assert token.stat().st_mode & 0o777 == 0o640
    assert fcm_token.refresh(cfg, now=101, mint=mint, post=rows.append) == 0
    assert len(calls) == 1
    def fail(*_a):
        raise ValueError("fixture-secret-token")
    assert fcm_token.refresh(cfg, now=2000, mint=fail, post=rows.append) == 1
    assert read(token) == saved  # a failed refresh keeps the still-usable token
    assert rows[-1]["state"] == "failed"
    assert "fixture-secret" not in capsys.readouterr().out


def test_route_sync_projects_keys_and_transfers_fresh_token(tmp_path):
    from host_steward import heartbeat
    account, devices, token = [tmp_path / name for name in ("account", "devices", "token")]
    account.write_text('{"project_id":"fixture", "private_key_id":"fixture-key"}')
    devices.write_text(json.dumps([{"fcm_token": "fixture", "enc_pub": "fixture", "auth": "fixture", "sig_pub": "must-stay-local"}]))
    token.write_text('{"access_token":"fixture-token", "expires_at":9999}')
    cfg = {"route": {"account": str(account), "devices": str(devices), "token": str(token), "base": "https://fixture"},
           "ssh": ["ssh", "fixture", "pve-sender", "heartbeat", "workstation"],
           "sync_command": ["pve-sender", "sync-credentials"], "timeout_s": 30}
    calls = []
    def execute(argv, **kwargs):
        calls.append((argv, json.loads(kwargs["input"])))
        return SimpleNamespace(returncode=0, stdout='{"synced":true}')
    assert heartbeat.sync_route(cfg, execute)
    assert calls[0][0] == ["ssh", "fixture", "pve-sender", "sync-credentials"]
    wire = calls[0][1]
    assert "sig_pub" not in wire["fcm"]["devices"][0]
    assert wire["token_cache"]["access_token"] == "fixture-token"
    assert wire["token_cache"]["key_id"] == "fixture-key"


def test_failed_route_sync_still_refreshes_host_heartbeat(tmp_path, monkeypatch):
    import io

    from host_steward import heartbeat
    config = json.loads((ROOT / "native/host-steward/host_steward/data/heartbeat.json").read_text())
    config["route"] = {"account": str(tmp_path / "absent")}
    monkeypatch.setattr(heartbeat.OPENER, "open", lambda *_a, **_k: io.StringIO('{"rows":[]}'))
    calls = []
    def execute(argv, **_kwargs):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout='{"heartbeat":"workstation","sender_age":1}')
    assert heartbeat.run(config, execute=execute, post=lambda *_a, **_k: True) == 1
    assert calls == [config["ssh"]]


def test_malformed_phone_does_not_stop_host_heartbeat(tmp_path, monkeypatch):
    import io

    from host_steward import heartbeat
    account, devices, token = [tmp_path / name for name in ("account", "devices", "token")]
    account.write_text('{"project_id":"fixture"}')
    devices.write_text('[null]')
    token.write_text('{}')
    config = json.loads((ROOT / "native/host-steward/host_steward/data/heartbeat.json").read_text())
    config["route"] = {"account": str(account), "devices": str(devices), "token": str(token), "base": "https://fixture"}
    monkeypatch.setattr(heartbeat.OPENER, "open", lambda *_a, **_k: io.StringIO('{"rows":[]}'))
    calls = []
    def execute(argv, **_kwargs):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout='{"heartbeat":"workstation","sender_age":1}')
    assert heartbeat.run(config, execute=execute, post=lambda *_a, **_k: True) == 1
    assert calls == [config["ssh"]]


def test_malformed_cached_token_expiry_reports_failure(tmp_path):
    from host_steward import fcm_token
    token = tmp_path / "token.json"
    token.write_text('{"access_token":"fixture", "expires_at":"bad"}')
    config = json.loads((ROOT / "native/host-steward/host_steward/data/fcm-token.json").read_text())
    config["token"] = str(token)
    config["account"] = str(tmp_path / "absent")
    rows = []
    assert fcm_token.refresh(config, now=100, post=rows.append) == 1
    assert rows[-1]["state"] == "failed"


def test_heartbeat_does_not_wait_for_slow_watchdog_lock(cfg, monkeypatch):
    import contextlib
    import io

    from pve_sender import cli
    path = Path(cfg["state_dir"]) / "config.json"
    write(path, cfg)
    locks = []
    @contextlib.contextmanager
    def lock(directory):
        locks.append(directory)
        yield
    monkeypatch.setattr(cli, "locked", lock)
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO('{}'))
    assert cli.main(["--config", str(path), "heartbeat", "workstation"]) == 0
    assert locks == [Path(cfg["state_dir"]) / "heartbeat-lock"]


def test_receipt_projection_returns_no_pairing_material(tmp_path):
    from host_steward import heartbeat
    devices = tmp_path / "devices.json"
    devices.write_text(json.dumps([{"fcm_token": "fixture-secret", "sig_pub": "fixture-secret", "last_message_ack": {
        "id": "test", "received_at": 100, "shown": True, "extra": "fixture-secret"}}]))
    cfg = {"route": {"devices": str(devices)}}
    assert heartbeat.message_receipts(cfg, "test") == [{"id": "test", "received_at": 100, "shown": True}]
    assert heartbeat.message_receipts(cfg, "other") == []
