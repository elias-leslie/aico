"""Rules, signed root update verification and unattended drill behavior."""

import io
import json
import os
import subprocess
import tarfile

import pytest

from host_steward import core, drill, escalation, installer


def test_rules_use_each_checks_real_deadline_and_clear_owner_rows():
    cfg = escalation.policy()
    saved = {}
    owner = {"ecc": {"at": 100, "valid_until": 10000, "signals": [{"code": "ecc.uncorrected", "state": "failed"}]}}
    first = escalation.run(owner, saved, cfg, 2000)
    assert first[0]["route"] == "owner"  # a slow check is not stale before its own deadline
    owner["ecc"]["signals"] = []
    cleared = escalation.run(owner, saved, cfg, 2001)
    assert cleared[0]["route"] == "clear-owner"
    assert cleared[0]["key"] == first[0]["key"]


def test_rules_act_once_per_episode_then_escalate_to_agents_and_clear():
    cfg = escalation.policy()
    saved, calls = {}, []
    observations = {"storage": {"at": 100, "valid_until": 2000, "signals": [{"code": "storage.disk.space", "state": "failed"}]}}
    command = lambda argv: calls.append(argv) or core.Result(0)
    first = escalation.run(observations, saved, cfg, 100, command)
    assert first[0]["route"] == "act" and len(calls) == 1
    assert escalation.run(observations, saved, cfg, 101, command)[0]["route"] == "agent"
    assert len(calls) == 1
    observations["storage"]["signals"][0]["state"] = "ok"
    escalation.run(observations, saved, cfg, 102, command)
    assert not saved


def test_rules_never_execute_unknown_or_owner_actions_and_stale_does_not_reset_episode():
    cfg, calls = escalation.policy(), []
    assert escalation.decide({"code": "ecc.uncorrected", "state": "failed"}, cfg)["route"] == "owner"
    assert escalation.decide({"code": "new.problem", "state": "failed"}, cfg)["route"] == "agent"
    assert escalation.decide({"code": "ws.units.failed", "state": "warn", "fields": {"units": "arbitrary.service"}}, cfg)["route"] == "agent"
    saved = {"storage:storage.disk.space": {"rc": 1}}
    escalation.run({"storage": {"at": 0, "valid_until": 100, "signals": []}}, saved, cfg, 999999, lambda cmd: calls.append(cmd))
    assert saved and not calls


def bundle(path, name="native/host-steward/install-root.sh", commit=None):
    headers = {"comment": commit} if commit else {}
    with tarfile.open(path, "w", format=tarfile.PAX_FORMAT, pax_headers=headers) as archive:
        data = b"#!/bin/sh\nexit 0\n"
        member = tarfile.TarInfo(name)
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))


def test_signed_update_accepts_only_the_pinned_signature_and_safe_paths(tmp_path):
    private, public = tmp_path / "key", tmp_path / "key.pub"
    archive, signature = tmp_path / "update.tar", tmp_path / "update.sig"
    subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private)], check=True, capture_output=True)
    subprocess.run(["openssl", "pkey", "-in", str(private), "-pubout", "-out", str(public)], check=True, capture_output=True)
    public.chmod(0o644)
    bundle(archive)

    def sign():
        subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(private), "-in", str(archive), "-out", str(signature)], check=True, capture_output=True)

    executed = []
    def execute(argv, **kwargs):
        if argv[0] != "openssl":
            executed.append(argv)
            return subprocess.CompletedProcess(argv, 0)
        return subprocess.run(argv, check=kwargs.pop("check", False), **kwargs)

    sign()
    receipt = tmp_path / "installed.json"
    installer.install(archive, signature, public, "native/host-steward/", execute=execute, owner=os.getuid(),
                      receipt=receipt)
    assert executed[-1] == ["systemctl", "--no-ask-password", "try-restart", "host-steward-grants.service"]
    assert json.loads(receipt.read_text())["sha"] is None  # no commit named in a hand-made archive
    bundle(archive, commit="a" * 40)  # as git archive names the commit
    sign()
    installer.install(archive, signature, public, "native/host-steward/", execute=execute, owner=os.getuid(),
                      receipt=receipt)
    assert json.loads(receipt.read_text())["sha"] == "a" * 40
    archive.write_bytes(archive.read_bytes() + b"changed")
    with pytest.raises(ValueError, match="signature"):
        installer.install(archive, signature, public, "native/host-steward/", execute=execute, owner=os.getuid())
    bundle(archive, "native/host-steward/../../escape")
    sign()
    with pytest.raises(ValueError, match="unexpected path"):
        installer.install(archive, signature, public, "native/host-steward/", execute=execute, owner=os.getuid())
    assert len(executed) == 4


def test_drill_always_revokes_even_when_a_use_fails():
    calls = []
    def call(msg):
        calls.append(msg["op"])
        if msg["op"] == "request":
            return {"id": "fixture"}
        if msg["op"] == "open":
            return {"ids": ["fixture"]}
        if msg["op"] == "use":
            raise ValueError("use failed")
        return {}
    with pytest.raises(ValueError, match="use failed"):
        drill.run(call)
    assert calls[-1] == "revoke"


def test_migrate_copies_each_old_file_once_with_its_mode(tmp_path, monkeypatch):
    old, new = tmp_path / "old", tmp_path / "new"
    old.mkdir()
    (old / "key").write_text("secret-key")
    (old / "site").write_text('{"a": 1}')
    policy = {"migration": {"files": [
        {"source": str(old / "key"), "target": str(new / "etc/key"), "mode": 0o600},
        {"source": str(old / "site"), "target": str(new / "aico/site.json"), "mode": 0o644, "dir_mode": 0o755},
        {"source": str(old / "missing"), "target": str(new / "etc/missing"), "mode": 0o600},
    ]}}
    monkeypatch.setattr(installer, "policy", lambda: policy)
    installer.migrate()
    assert (new / "etc/key").read_text() == "secret-key" and (new / "etc/key").stat().st_mode & 0o777 == 0o600
    assert (new / "etc").stat().st_mode & 0o777 == 0o700
    assert (new / "aico/site.json").stat().st_mode & 0o777 == 0o644
    assert not (new / "etc/missing").exists()
    (old / "key").write_text("changed")
    installer.migrate()
    assert (new / "etc/key").read_text() == "secret-key"  # a target that exists is never replaced


def test_data_files_name_no_nightshift_locations():
    data = installer.core.DATA_DIR
    moved = ("/etc/nightshift", "/var/lib/nightshift", "/run/nightshift", ".local/state/nightshift")
    for path in sorted(data.iterdir()):
        if path.name == "installer.toml":
            continue  # the one-time copy sources
        text = path.read_text()
        assert not [place for place in moved if place in text], path.name
