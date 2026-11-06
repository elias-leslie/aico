"""input-watch, display-guard and home-off: the decisions that need no devices, no GNOME and no network."""

from __future__ import annotations

import json
import os
import struct
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

from host_steward import fcm_wire
from host_steward.jobs import JOBS, display_guard, home_off, input_watch


def test_jobs_are_registered_under_their_unit_names():
    assert {"input-watch", "display-guard", "home-off"} <= set(JOBS)


# input-watch


def event(kind: int) -> bytes:
    return struct.pack("@llHHi", 0, 0, kind, 0, 1)


def test_human_events_are_keys_buttons_and_movement_only():
    assert input_watch.human_events(event(input_watch.EV_KEY))
    assert input_watch.human_events(event(input_watch.EV_REL))
    assert input_watch.human_events(event(0) + event(input_watch.EV_ABS))
    assert not input_watch.human_events(event(0) + event(4) + event(0x11))  # sync, misc, led
    assert not input_watch.human_events(b"")


def test_virtual_devices_are_not_physical(tmp_path, monkeypatch):
    real = {
        "/sys/class/input/event3": "/sys/devices/pci0000:00/usb1/input/input3/event3",
        "/sys/class/input/event9": "/sys/devices/virtual/input/input9/event9",
        "/sys/class/input/event7": "/sys/devices/virtual/misc/uhid/0005/input/input7/event7",
    }
    monkeypatch.setattr(os.path, "realpath", lambda p: real[str(p)])
    assert input_watch.is_physical(Path("/sys/class/input/event3"))
    assert not input_watch.is_physical(Path("/sys/class/input/event9"))  # ydotoold's uinput
    assert input_watch.is_physical(Path("/sys/class/input/event7"))  # a Bluetooth keyboard


def test_touch_is_rate_limited_and_stamp_follows_the_unit_directory(tmp_path):
    stamp = tmp_path / "physical-input"
    watch = input_watch.Watch(stamp)
    watch.touch(100.0)
    first = stamp.stat().st_mtime
    os.utime(stamp, (1, 1))
    watch.touch(100.5)  # inside touch_every_s
    assert stamp.stat().st_mtime == 1
    watch.touch(101.5)
    assert stamp.stat().st_mtime >= first
    assert input_watch.stamp_path() == Path("/run/host-steward-input/physical-input")


# display-guard


def test_effective_delay_floors_gnome_but_keeps_never():
    assert display_guard.effective_delay(0, 300) == 0
    assert display_guard.effective_delay(60, 300) == 300
    assert display_guard.effective_delay(900, 300) == 900


def test_idle_is_the_stamp_age_and_a_missing_stamp_is_unknown(tmp_path):
    stamp = tmp_path / "physical-input"
    idle, why = display_guard.physical_idle(stamp)
    assert idle is None and "no stamp" in why
    stamp.touch()
    os.utime(stamp, (time.time() - 120, time.time() - 120))
    idle, why = display_guard.physical_idle(stamp)
    assert why == "" and idle is not None and 119 <= idle <= 125


class Monitor:
    def __init__(self, delay=300, on=True, inhibited=False):
        self.delay, self.on, self.inhibited, self.calls = delay, on, inhibited, []

    def install(self, monkeypatch):
        monkeypatch.setattr(display_guard, "idle_delay", lambda: self.delay)
        monkeypatch.setattr(display_guard, "monitor_on", lambda: self.on)
        monkeypatch.setattr(display_guard, "idle_inhibited", lambda: self.inhibited)
        monkeypatch.setattr(
            display_guard, "blank_monitor", lambda: self.calls.append("off") or True
        )
        monkeypatch.setattr(display_guard, "wake_monitor", lambda: self.calls.append("on") or True)


def test_blanks_after_the_idle_delay_without_physical_input(monkeypatch):
    mon = Monitor()
    mon.install(monkeypatch)
    guard = display_guard.Guard(poll_s=20)
    assert not guard.tick(100, 0)  # input 100 s ago: not yet
    assert guard.tick(301, 20)  # first blank in this stretch
    assert guard.dark and mon.calls == ["off"]


def test_physical_input_wakes_it_but_an_unknown_stamp_never_blanks(monkeypatch):
    mon = Monitor()
    mon.install(monkeypatch)
    guard = display_guard.Guard(poll_s=20)
    assert not guard.tick(None, 0)  # no stamp: wait, never blank on a guess
    assert mon.calls == []
    guard.tick(400, 1)
    assert guard.dark
    guard.tick(2, 2)  # the stamp moved: the owner is back
    assert not guard.dark and mon.calls == ["off", "on"]


def test_never_blank_setting_and_inhibitors_are_respected(monkeypatch):
    never = Monitor(delay=0)
    never.install(monkeypatch)
    guard = display_guard.Guard(poll_s=20)
    guard.tick(10_000, 0)
    assert never.calls == []
    video = Monitor(inhibited=True)
    video.install(monkeypatch)
    display_guard.Guard(poll_s=20).tick(10_000, 0)
    assert video.calls == []


# home-off


LISTING = "123 reboot.target start waiting\n"


def test_reboot_targets_in_the_job_list_mean_a_reboot():
    assert home_off.queued_target("12 reboot.target start waiting")
    assert home_off.queued_target("12 kexec.target start waiting")
    assert home_off.queued_target("12 soft-reboot.target start running")
    assert not home_off.queued_target(
        "12 poweroff.target start waiting\n13 reboot.target stop waiting"
    )
    assert not home_off.queued_target("")


def test_reboot_queued_reads_systemctl_and_fails_open():
    def run(listing, rc=0):
        return lambda *_a, **_k: SimpleNamespace(returncode=rc, stdout=listing)

    assert home_off.reboot_queued(run(LISTING))
    assert not home_off.reboot_queued(run(LISTING, rc=1))  # unknown reads as no reboot

    def missing(*_a, **_k):
        raise OSError

    def slow(*_a, **_k):
        raise subprocess.TimeoutExpired("systemctl", 5)

    assert not home_off.reboot_queued(missing)
    assert not home_off.reboot_queued(slow)


def test_plaintext_and_message_shape():
    plain = json.loads(home_off.plaintext(1700000000.9, "box"))
    assert plain == {
        "v": 1,
        "id": "h1700000000",
        "ts": 1700000000,
        "kind": "home-off",
        "host": "box",
    }
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    pub = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    dev = {"fcm_token": "tok", "enc_pub": fcm_wire.b64u(pub), "auth": fcm_wire.b64u(os.urandom(16))}
    msg = home_off.message(dev, home_off.plaintext(1.0, "box"), 43200)["message"]
    assert msg["token"] == "tok"
    assert set(msg) == {"token", "data", "android"}  # data only: no notification block
    assert msg["data"]["t"] == "p" and msg["data"]["ct"]
    assert msg["android"] == {"priority": "HIGH", "ttl": "43200s"}


def route_files(tmp_path, devices, token=None):
    phones = tmp_path / "phones.json"
    phones.write_text(json.dumps(devices))
    tokfile = tmp_path / "token.json"
    if token is not None:
        tokfile.write_text(json.dumps(token))
    return {"devices": str(phones), "token": str(tokfile), "account": str(tmp_path / "none.json")}


def test_only_pairable_phones_get_it(tmp_path):
    good = {"fcm_token": "a", "enc_pub": "b", "auth": "c", "extra": "x"}
    route = route_files(
        tmp_path,
        [good, {**good, "token_gone": True}, {"fcm_token": "a"}, "junk"],
    )
    assert home_off.paired_devices(route) == [{"fcm_token": "a", "enc_pub": "b", "auth": "c"}]


def test_send_posts_one_message_per_phone_with_the_kept_token(tmp_path, monkeypatch):
    now = time.time()
    route = route_files(
        tmp_path,
        [
            {"fcm_token": "a", "enc_pub": "b", "auth": "c"},
            {"fcm_token": "d", "enc_pub": "e", "auth": "f"},
        ],
        {"access_token": "T", "expires_at": now + 3000, "project_id": "proj"},
    )
    monkeypatch.setattr(
        home_off, "message", lambda dev, plain, ttl: {"to": dev["fcm_token"], "ttl": ttl}
    )
    sent = []

    def post(project, token, body, timeout):
        sent.append((project, token, body, timeout))
        return 200 if body["to"] == "a" else 404

    cfg = {"ttl_s": 43200, "request_timeout_s": 8.0}
    line = home_off.send(route, cfg, time.time() + 15, now, post)
    assert line == "app home-off: 200, 404"
    assert [s[:2] for s in sent] == [("proj", "T"), ("proj", "T")]
    assert all(s[3] <= 8.0 for s in sent) and sent[0][2]["ttl"] == 43200


def test_send_is_skipped_without_phones_or_token(tmp_path):
    cfg = {"ttl_s": 1, "request_timeout_s": 1.0}
    assert "no paired app" in home_off.send(route_files(tmp_path, []), cfg, time.time() + 5)
    lone = route_files(tmp_path, [{"fcm_token": "a", "enc_pub": "b", "auth": "c"}])
    assert "no FCM access token" in home_off.send(lone, cfg, time.time() + 5)


def test_an_expired_deadline_sends_nothing(tmp_path):
    route = route_files(
        tmp_path,
        [{"fcm_token": "a", "enc_pub": "b", "auth": "c"}],
        {"access_token": "T", "expires_at": time.time() + 3000, "project_id": "p"},
    )
    cfg = {"ttl_s": 1, "request_timeout_s": 1.0}

    def never(*_a):
        raise AssertionError("posted after the deadline")

    assert home_off.send(route, cfg, time.time() - 1, send_one=never) == "app home-off: no time"


def test_a_queued_reboot_sends_nothing(monkeypatch, capsys):
    monkeypatch.setattr(home_off, "reboot_queued", lambda: True)
    monkeypatch.setattr(home_off, "send", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError))
    assert home_off.main(SimpleNamespace(heartbeat_data=Path("/nonexistent")), {}, None) == 0
    assert "reboot queued" in capsys.readouterr().out
